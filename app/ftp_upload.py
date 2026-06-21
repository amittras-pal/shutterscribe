"""
ShutterScribe — Shutterstock FTPS Upload Utility

Handles uploading processed images from content/output/ to Shutterstock's
FTPS server using Explicit FTP over TLS (AUTH TLS), as documented at:
https://submit.shutterstock.com/help/en/articles/10617392-how-do-i-upload-content-via-ftps

Supports serial and parallel uploads. Parallel mode opens N independent FTPS
connections (one per worker), each reused for its entire batch of files to
amortise TLS handshake overhead. Worker count is controlled via:
    SHUTTERSTOCK_FTP_PARALLEL — number of concurrent connections (default: 1)

Credentials and connection settings are read from environment variables
(loaded from a .env file via python-dotenv).

Environment Variables:
    SHUTTERSTOCK_FTP_USER     — Contributor email or username
    SHUTTERSTOCK_FTP_PASSWORD — Contributor account password
    SHUTTERSTOCK_FTP_HOST     — FTP host      (default: ftps.shutterstock.com)
    SHUTTERSTOCK_FTP_PORT     — FTP port      (default: 21)
    SHUTTERSTOCK_FTP_PARALLEL — Worker count  (default: 1, recommended max: 3)
"""

import ftplib
import logging
import os
import ssl
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Optional

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger("shutterscribe.ftp")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Load .env from the app/ directory (this file's directory)
_APP_DIR = Path(__file__).parent
load_dotenv(dotenv_path=_APP_DIR / ".env")

PROJECT_ROOT = _APP_DIR.parent
OUTPUT_DIR = str(PROJECT_ROOT / "content" / "output")

# FTPS connection defaults (overridable via .env)
DEFAULT_HOST = "ftps.shutterstock.com"
DEFAULT_PORT = 21
DEFAULT_PARALLEL = 1  # Serial by default; set SHUTTERSTOCK_FTP_PARALLEL to increase

# Supported image extensions for upload
UPLOAD_EXTENSIONS = (".jpg", ".jpeg")


# ---------------------------------------------------------------------------
# FTPS Uploader
# ---------------------------------------------------------------------------

class FTPUploader:
    """
    Manages the lifecycle of a single FTPS connection to Shutterstock.

    Uses Explicit FTP over TLS (AUTH TLS / FTPS) on port 21.
    TLS certificate verification is intentionally disabled to match the
    behaviour Shutterstock instructs for GUI clients (trust all certs).
    Passive mode is enabled by default for NAT/firewall compatibility.

    Each instance owns exactly one connection. For parallel uploads, create
    one FTPUploader per worker thread — ftplib.FTP_TLS is NOT thread-safe.
    """

    def __init__(self):
        self.host: str = os.getenv("SHUTTERSTOCK_FTP_HOST", DEFAULT_HOST)
        self.port: int = int(os.getenv("SHUTTERSTOCK_FTP_PORT", str(DEFAULT_PORT)))
        self.user: str = os.getenv("SHUTTERSTOCK_FTP_USER", "")
        self.password: str = os.getenv("SHUTTERSTOCK_FTP_PASSWORD", "")
        self._ftp: Optional[ftplib.FTP_TLS] = None

    def _build_ssl_context(self) -> ssl.SSLContext:
        """
        Build an SSL context that mirrors Shutterstock's 'trust all certs'
        guidance for their FTPS server (self-signed / untrusted cert).
        """
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    def connect(self) -> None:
        """Open the FTPS connection, upgrade to TLS, and log in."""
        if not self.user or not self.password:
            raise ValueError(
                "SHUTTERSTOCK_FTP_USER and SHUTTERSTOCK_FTP_PASSWORD "
                "must be set in the .env file."
            )

        logger.info("Connecting to %s:%d", self.host, self.port)
        ssl_ctx = self._build_ssl_context()
        self._ftp = ftplib.FTP_TLS(context=ssl_ctx)
        self._ftp.connect(host=self.host, port=self.port)
        logger.info("TCP connection established")

        # Upgrade control channel to TLS (Explicit AUTH TLS)
        self._ftp.auth()
        logger.info("TLS handshake complete (AUTH TLS)")

        # Log in with contributor credentials
        self._ftp.login(user=self.user, passwd=self.password)
        logger.info("Logged in as %s", self.user)

        # Upgrade data channel to TLS (PROT P)
        self._ftp.prot_p()
        logger.info("Data channel upgraded to TLS (PROT P)")

        # Enable passive mode (PASV) — required behind most NAT/firewalls
        self._ftp.set_pasv(True)
        logger.info("Passive mode enabled")

    def upload_file(self, local_path: str) -> None:
        """Upload a single file to the remote root directory."""
        if self._ftp is None:
            raise RuntimeError("FTP connection is not open. Call connect() first.")

        filename = os.path.basename(local_path)
        file_size = os.path.getsize(local_path)
        logger.info("Uploading: %s (%.1f KB)", filename, file_size / 1024)
        with open(local_path, "rb") as f:
            self._ftp.storbinary(f"STOR {filename}", f)
        logger.info("Upload complete: %s", filename)

    def disconnect(self) -> None:
        """Gracefully close the FTPS connection."""
        if self._ftp is not None:
            try:
                self._ftp.quit()
                logger.info("FTP session closed (QUIT)")
            except Exception:
                self._ftp.close()
                logger.info("FTP session force-closed")
            finally:
                self._ftp = None


# ---------------------------------------------------------------------------
# Worker (runs in a thread pool thread)
# ---------------------------------------------------------------------------

def _upload_worker(
    file_batch: list,
    worker_id: int,
    counters: dict,
    lock: threading.Lock,
    total: int,
    errors: list,
    progress_callback: Optional[Callable],
) -> None:
    """
    Upload a batch of files over a single persistent FTPS connection.

    Designed to run inside a ThreadPoolExecutor. Each worker owns its own
    FTPUploader instance (connections are not shared across threads).

    Counter updates are protected by `lock` so that the values passed to
    `progress_callback` are always atomically consistent, even when multiple
    workers fire callbacks concurrently.

    Progress callback signature:
        (filename, uploaded, failed, total, status, error_msg)
    """
    uploader = FTPUploader()

    # Connect — if connection fails, mark entire batch as failed
    try:
        uploader.connect()
    except Exception as exc:
        error_msg = str(exc)
        logger.error("Worker %d: Connection failed: %s", worker_id, exc, exc_info=True)
        for file_path in file_batch:
            with lock:
                counters["failed"] += 1
                errors.append({"filename": file_path.name, "error": error_msg})
                u, f = counters["uploaded"], counters["failed"]
            if progress_callback:
                progress_callback(file_path.name, u, f, total, "failed", error_msg)
        return

    try:
        for file_path in file_batch:
            filename = file_path.name
            try:
                uploader.upload_file(str(file_path))

                # Delete from output/ after confirmed server-side write
                file_path.unlink()
                logger.info("Worker %d: Deleted local file after upload: %s", worker_id, filename)

                with lock:
                    counters["uploaded"] += 1
                    u, f = counters["uploaded"], counters["failed"]

                if progress_callback:
                    progress_callback(filename, u, f, total, "uploaded", "")

            except Exception as exc:
                error_msg = str(exc)
                logger.error(
                    "Worker %d: Failed to upload %s: %s",
                    worker_id, filename, error_msg, exc_info=True
                )
                with lock:
                    counters["failed"] += 1
                    errors.append({"filename": filename, "error": error_msg})
                    u, f = counters["uploaded"], counters["failed"]

                if progress_callback:
                    progress_callback(filename, u, f, total, "failed", error_msg)

    finally:
        uploader.disconnect()


# ---------------------------------------------------------------------------
# High-level upload orchestration
# ---------------------------------------------------------------------------

def upload_output_directory(
    progress_callback: Optional[Callable[[str, int, int, int, str, str], None]] = None,
    n_workers: Optional[int] = None,
) -> dict:
    """
    Upload all JPEG images from content/output/ to Shutterstock via FTPS.

    Files are distributed round-robin across N worker connections. Each
    connection is opened once and reused for its entire batch to amortise
    TLS handshake cost. After a successful upload each file is deleted from
    the output directory to prevent accidental re-uploads.

    Args:
        progress_callback: Optional callable fired after each file attempt.
            Signature: (filename, uploaded, failed, total, status, error_msg)
            All counter arguments reflect the atomically-updated totals at
            the moment the callback fires.
        n_workers: Number of parallel FTPS connections. Overrides the
            SHUTTERSTOCK_FTP_PARALLEL env var if provided. Clamped to
            [1, total_files]. Defaults to the env var (or 1 if unset).

    Returns:
        A summary dict with keys: total, uploaded, failed, errors (list of dicts)

    Raises:
        ValueError: If FTP credentials are missing.
        ftplib.all_errors: If ALL workers fail to connect.
    """
    # Collect uploadable files
    output_path = Path(OUTPUT_DIR)
    if not output_path.exists():
        return {"total": 0, "uploaded": 0, "failed": 0, "errors": []}

    files = sorted(
        p for p in output_path.iterdir()
        if p.is_file() and p.suffix.lower() in UPLOAD_EXTENSIONS
    )

    total = len(files)
    if total == 0:
        logger.info("No files found in output directory, nothing to upload")
        return {"total": 0, "uploaded": 0, "failed": 0, "errors": []}

    # Resolve worker count: argument → env var → default (1 = serial)
    if n_workers is None:
        n_workers = int(os.getenv("SHUTTERSTOCK_FTP_PARALLEL", str(DEFAULT_PARALLEL)))
    n_workers = max(1, min(n_workers, total))  # clamp: at least 1, at most one per file

    logger.info(
        "Starting FTPS upload: %d file(s) across %d worker connection(s)",
        total, n_workers
    )

    # Shared mutable state — all mutations are protected by the lock
    counters: dict = {"uploaded": 0, "failed": 0}
    lock = threading.Lock()
    errors: list = []

    # Distribute files round-robin: worker i gets files[i], files[i+N], files[i+2N], …
    batches = [files[i::n_workers] for i in range(n_workers)]

    if n_workers == 1:
        # Serial path: skip thread pool overhead entirely
        _upload_worker(batches[0], 0, counters, lock, total, errors, progress_callback)
    else:
        with ThreadPoolExecutor(max_workers=n_workers, thread_name_prefix="ftp-worker") as pool:
            futures = {
                pool.submit(_upload_worker, batch, i, counters, lock, total, errors, progress_callback): i
                for i, batch in enumerate(batches)
                if batch  # skip empty batches when files < n_workers
            }
            for future in as_completed(futures):
                worker_id = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    # Workers already handle their own exceptions internally;
                    # this catches truly unexpected failures (e.g. OOM)
                    logger.error(
                        "Worker %d raised an unhandled exception: %s",
                        worker_id, exc, exc_info=True
                    )

    logger.info(
        "Upload session complete: %d uploaded, %d failed out of %d total",
        counters["uploaded"], counters["failed"], total
    )
    return {
        "total": total,
        "uploaded": counters["uploaded"],
        "failed": counters["failed"],
        "errors": errors,
    }
