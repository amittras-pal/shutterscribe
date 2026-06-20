"""
Local AI Shutterstock Automation - Image Processing Pipeline

Automates visual analysis of exported stock photos, generates
platform-compliant metadata (titles, descriptions, categories, keywords)
using a quantized local Vision-Language Model (VLM) via Ollama,
and produces a Shutterstock-compatible CSV for bulk upload.

Optionally embeds metadata into image EXIF/IPTC/XMP tags via ExifTool
when the --embed flag is passed.
"""

import argparse
import os
import csv
import shutil
import subprocess
from datetime import datetime
from typing import List, Literal, Optional

from PIL import Image
from pydantic import BaseModel, Field
import ollama


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Project root is one level up from this script (app/ -> stocks-auto/)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Content directories (under content/)
CONTENT_DIR = os.path.join(PROJECT_ROOT, "content")
RAW_DIR = os.path.join(CONTENT_DIR, "raw")
OUTPUT_DIR = os.path.join(CONTENT_DIR, "output")
CSV_DIR = os.path.join(CONTENT_DIR, "csv")
LOGS_DIR = os.path.join(PROJECT_ROOT, "app", "logs")

# App-level paths
PROCESSING_DIR = os.path.join(PROJECT_ROOT, "app", "processing")
EXIFTOOL_PATH = os.path.join(PROJECT_ROOT, "app", "exiftool", "exiftool.exe")
OLLAMA_MODEL = "qwen2.5vl:3b"
DOWNSAMPLE_MAX_EDGE = 1200  # px, longest edge for VLM inference


# ---------------------------------------------------------------------------
# Metadata Schema (Pydantic)
# ---------------------------------------------------------------------------

# Predefined Shutterstock Categories
ShutterstockCategory = Literal[
    "Abstract", "Animals/Wildlife", "Arts", "Backgrounds/Textures",
    "Beauty/Fashion", "Buildings/Landmarks", "Business/Finance",
    "Celebrities", "Education", "Food and drink", "Healthcare/Medical",
    "Holidays", "Industrial", "Interiors", "Miscellaneous", "Nature",
    "Objects", "Parks/Outdoor", "People", "Religion", "Science",
    "Signs", "Sports/Recreation", "Technology", "Transportation", "Vintage"
]


class ShutterstockMetadata(BaseModel):
    title: str = Field(
        ...,
        description=(
            "A concise, factual title describing the photo. "
            "Max 150 characters. No keyword stuffing or brand names."
        ),
    )
    description: str = Field(
        ...,
        description=(
            "A factual sentence describing the photo's subject matter in English. "
            "Max 2048 characters. Avoid subjective filler words."
        ),
    )
    categories: List[ShutterstockCategory] = Field(
        ...,
        min_length=1,
        max_length=2,
        description=(
            "Exactly 1 or 2 categories from the predefined "
            "Shutterstock category list."
        ),
    )
    keywords: List[str] = Field(
        ...,
        description=(
            "A list of 20 to 30 highly relevant keywords or short phrases. "
            "Do not include subjective words (e.g., 'beautiful', 'amazing', 'best'). "
            "All keywords must be lowercase."
        ),
    )


# ---------------------------------------------------------------------------
# System Prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "IMPORTANT: You must respond ONLY in English. Never use Chinese, "
    "Japanese, Korean, or any non-English characters in any field.\n\n"
    "You are an expert metadata tagger for professional stock photography "
    "uploaded to Shutterstock. Analyze the provided image and generate "
    "metadata conforming to the requested JSON schema.\n"
    "Rules:\n"
    "1. Titles and descriptions must be highly factual, objective, and "
    "describe the literal contents of the photo. Avoid creative, poetic, "
    "or subjective storytelling.\n"
    "2. Do not use trademarked brands, names, or copyrighted terms.\n"
    "3. Generate between 20 and 30 keywords. Keywords must be relevant, "
    "lowercase, and free of generic/subjective fluff like 'beautiful', "
    "'awesome', 'nice', or 'best'.\n"
    "4. Ensure categories match the predefined list and directly represent "
    "the primary subject.\n"
    "5. ALL output text must be in English only. No exceptions."
)


# ---------------------------------------------------------------------------
# Image Downsampling
# ---------------------------------------------------------------------------

def create_downsample(source_path: str, dest_path: str) -> None:
    """Create a downsampled JPEG copy with longest edge = DOWNSAMPLE_MAX_EDGE.

    Uses LANCZOS resampling for quality. The original file is untouched.
    """
    with Image.open(source_path) as img:
        w, h = img.size
        longest = max(w, h)

        if longest <= DOWNSAMPLE_MAX_EDGE:
            # Already small enough — just copy as-is
            shutil.copy2(source_path, dest_path)
            return

        scale = DOWNSAMPLE_MAX_EDGE / longest
        new_size = (int(w * scale), int(h * scale))
        resized = img.resize(new_size, Image.LANCZOS)
        resized.save(dest_path, "JPEG", quality=85)


# ---------------------------------------------------------------------------
# ExifTool Metadata Writer (optional, used with --embed)
# ---------------------------------------------------------------------------

def write_metadata(image_path: str, metadata: ShutterstockMetadata) -> None:
    """Embed Shutterstock-compliant metadata into image EXIF/IPTC/XMP tags."""

    # Convert keywords list to a single comma-separated string
    keywords_str = ", ".join(metadata.keywords)

    # Select categories
    primary_category = metadata.categories[0]
    secondary_category = (
        metadata.categories[1] if len(metadata.categories) > 1 else ""
    )

    # Build the ExifTool command
    cmd = [
        EXIFTOOL_PATH,
        "-overwrite_original",
        "-sep", ", ",
        f"-XMP-dc:Title={metadata.title}",
        f"-IPTC:ObjectName={metadata.title}",
        f"-XMP-dc:Description={metadata.description}",
        f"-IPTC:Caption-Abstract={metadata.description}",
        f"-XMP-dc:Subject={keywords_str}",
        f"-IPTC:Keywords={keywords_str}",
        f"-XMP-photoshop:Category={primary_category}",
    ]

    if secondary_category:
        cmd.append(
            f"-XMP-photoshop:SupplementalCategories={secondary_category}"
        )

    cmd.append(image_path)

    # Execute subprocess
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ExifTool failed: {result.stderr.strip()}")


# ---------------------------------------------------------------------------
# VLM Inference (with non-English retry)
# ---------------------------------------------------------------------------

def run_vlm_inference(processing_path: str) -> ShutterstockMetadata:
    """Run Ollama VLM inference and return validated metadata.

    Retries once if non-English text is detected in the output.
    """
    response = ollama.chat(
        model=OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "Generate metadata for this image.",
                "images": [processing_path],
            },
        ],
        options={"temperature": 0.0, "num_ctx": 6144, "num_gpu": 999},
        format=ShutterstockMetadata.model_json_schema(),
    )

    response_json = response["message"]["content"]
    metadata = ShutterstockMetadata.model_validate_json(response_json)

    # Check for non-English characters and retry once
    all_text = (
        metadata.title + metadata.description
        + " ".join(metadata.keywords)
    )
    if not all_text.isascii():
        print("  ⚠ Non-English text detected, retrying...")
        response = ollama.chat(
            model=OLLAMA_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": (
                        "Generate metadata for this image. "
                        "Use ONLY English words and characters."
                    ),
                    "images": [processing_path],
                },
            ],
            options={"temperature": 0.0, "num_ctx": 6144, "num_gpu": 999},
            format=ShutterstockMetadata.model_json_schema(),
        )
        response_json = response["message"]["content"]
        metadata = ShutterstockMetadata.model_validate_json(response_json)

        # If still non-English after retry, fail this image
        all_text = (
            metadata.title + metadata.description
            + " ".join(metadata.keywords)
        )
        if not all_text.isascii():
            raise ValueError("VLM produced non-English text after retry")

    return metadata


# ---------------------------------------------------------------------------
# Main Pipeline
# ---------------------------------------------------------------------------

def process_batch(embed: bool = False, status_callback=None) -> Optional[str]:
    """Process all JPEG images in the raw/ directory sequentially.

    Workflow per image:
      1. Create a downsampled copy (1200px long edge) in processing/
      2. Run VLM inference on the downsample
      3. Record metadata in a Shutterstock-compatible CSV
      4. Optionally embed metadata via ExifTool (--embed flag)
      5. Move original to output/, delete the downsample
      On failure the original stays in raw/ for easy retry.
    """

    # Ensure directories exist
    for d in [RAW_DIR, PROCESSING_DIR, OUTPUT_DIR, CSV_DIR, LOGS_DIR]:
        os.makedirs(d, exist_ok=True)

    # Get strictly JPG/JPEG files
    files = [
        f for f in os.listdir(RAW_DIR)
        if f.lower().endswith((".jpg", ".jpeg"))
    ]

    if not files:
        print("No JPG/JPEG files found in the raw/ directory.")
        return None

    mode_label = "CSV + EXIF embed" if embed else "CSV only"
    print(f"Found {len(files)} image(s) to process. Mode: {mode_label}\n")

    print("Pre-generating downsampled thumbnails...")
    for file in files:
        source_path = os.path.join(RAW_DIR, file)
        processing_path = os.path.join(PROCESSING_DIR, file)
        if not os.path.exists(processing_path):
            create_downsample(source_path, processing_path)

    # Generate timestamped file names
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    csv_path = os.path.join(CSV_DIR, f"shutterstock_{timestamp}.csv")
    log_path = os.path.join(LOGS_DIR, f"run_log_{timestamp}.csv")

    success_count = 0
    fail_count = 0

    # Open both CSV files
    with (
        open(csv_path, mode="w", newline="", encoding="utf-8") as ss_file,
        open(log_path, mode="w", newline="", encoding="utf-8") as log_file,
    ):
        # Shutterstock CSV — official column order
        ss_fields = [
            "Filename", "Description", "Keywords",
            "Categories", "Illustration", "Mature Content", "Editorial",
        ]
        ss_writer = csv.DictWriter(ss_file, fieldnames=ss_fields)
        ss_writer.writeheader()

        # Run log — technical fields only
        log_fields = [
            "image_name", "status", "error_message",
            "start_time", "end_time", "processing_seconds",
        ]
        log_writer = csv.DictWriter(log_file, fieldnames=log_fields)
        log_writer.writeheader()

        for idx, file in enumerate(files, start=1):
            source_path = os.path.join(RAW_DIR, file)
            processing_path = os.path.join(PROCESSING_DIR, file)

            print(f"[{idx}/{len(files)}] Processing: {file}")

            # Record start time
            start_time = datetime.now()

            # Prepare log entry defaults
            log_entry = {
                "image_name": file,
                "status": "failed",
                "error_message": "",
                "start_time": start_time.strftime("%Y-%m-%d %H:%M:%S"),
                "end_time": "",
                "processing_seconds": "",
            }

            try:
                if status_callback:
                    status_callback(file, "processing", None)

                # Step 2: Run VLM inference
                metadata = run_vlm_inference(processing_path)

                # Step 3: Write Shutterstock CSV row
                ss_writer.writerow({
                    "Filename": file,
                    "Description": metadata.description,
                    "Keywords": ",".join(metadata.keywords),
                    "Categories": ",".join(metadata.categories),
                    "Illustration": "No",
                    "Mature Content": "No",
                    "Editorial": "No",
                })
                ss_file.flush()

                # Step 4: Optionally embed metadata via ExifTool
                if embed:
                    write_metadata(source_path, metadata)

                # Step 5: Move original to output/
                final_path = os.path.join(OUTPUT_DIR, file)
                shutil.move(source_path, final_path)

                log_entry["status"] = "success"
                success_count += 1
                if status_callback:
                    status_callback(file, "success", metadata.model_dump())
                print(f"  ✓ Success — {metadata.title[:60]}...")

            except Exception as e:
                # Original stays in raw/ for retry on next run
                error_msg = str(e)
                log_entry["error_message"] = error_msg
                log_entry["status"] = "failed"

                fail_count += 1
                if status_callback:
                    status_callback(file, "failed", error_msg)
                print(f"  ✗ Failed — {error_msg}")

            finally:
                # Clean up the downsample from processing/
                # Commented out so the web interface can use it
                # if os.path.exists(processing_path):
                #     os.remove(processing_path)

                # Record end time and compute duration
                end_time = datetime.now()
                elapsed = (end_time - start_time).total_seconds()
                log_entry["end_time"] = end_time.strftime("%Y-%m-%d %H:%M:%S")
                log_entry["processing_seconds"] = f"{elapsed:.1f}"

                # Write log record
                log_writer.writerow(log_entry)
                log_file.flush()

                print(f"  ⏱ {elapsed:.1f}s")

    # Summary
    print(f"\n{'='*50}")
    print(f"Batch complete: {success_count} succeeded, {fail_count} failed")
    print(f"Shutterstock CSV: {csv_path}")
    print(f"Run log:          {log_path}")
    print(f"{'='*50}")

    return csv_path


# ---------------------------------------------------------------------------
# Entry Point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Process stock photos and generate Shutterstock metadata."
    )
    parser.add_argument(
        "--embed",
        action="store_true",
        help="Also embed metadata into image EXIF/IPTC/XMP tags via ExifTool.",
    )
    args = parser.parse_args()
    process_batch(embed=args.embed)


if __name__ == "__main__":
    main()
