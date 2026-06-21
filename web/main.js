const elements = {
    headerStatus: document.getElementById('header-status'),
    pulseDot: document.querySelector('.pulse-dot'),
    statusText: document.getElementById('status-text'),

    launchView: document.getElementById('launch-view'),
    fileCount: document.getElementById('file-count'),
    startBtn: document.getElementById('start-btn'),
    startError: document.getElementById('start-error'),

    tableView: document.getElementById('table-view'),
    tableBody: document.getElementById('table-body'),
    progressText: document.getElementById('progress-text'),
    errorCount: document.getElementById('error-count'),
    clearBtn: document.getElementById('clear-btn'),
    uploadBtn: document.getElementById('upload-btn'),
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),

    prevPage: document.getElementById('prev-page'),
    nextPage: document.getElementById('next-page'),
    pageInfo: document.getElementById('page-info'),

    // Upload progress bar elements
    uploadProgressSection: document.getElementById('upload-progress-section'),
    uploadProgressFill: document.getElementById('upload-progress-fill'),
    uploadStatusText: document.getElementById('upload-status-text'),
    uploadErrorCount: document.getElementById('upload-error-count'),

    editModal: document.getElementById('edit-modal'),
    closeModal: document.getElementById('close-modal'),
    cancelEdit: document.getElementById('cancel-edit'),
    saveEdit: document.getElementById('save-edit'),
    saveError: document.getElementById('save-error'),
    editForm: document.getElementById('edit-form'),

    editFilename: document.getElementById('edit-filename'),
    editTitle: document.getElementById('edit-title'),
    editDescription: document.getElementById('edit-description'),
    editKeywords: document.getElementById('edit-keywords'),
    editCategory1: document.getElementById('edit-category-1'),
    editCategory2: document.getElementById('edit-category-2'),
    editImagePreview: document.getElementById('edit-image-preview')
};

const STOCK_CATEGORIES = [
    "Abstract", "Animals/Wildlife", "Arts", "Backgrounds/Textures",
    "Beauty/Fashion", "Buildings/Landmarks", "Business/Finance",
    "Celebrities", "Education", "Food and drink", "Healthcare/Medical",
    "Holidays", "Industrial", "Interiors", "Miscellaneous", "Nature",
    "Objects", "Parks/Outdoor", "People", "Religion", "Science",
    "Signs", "Sports/Recreation", "Technology", "Transportation", "Vintage"
];

// Initialize category options
STOCK_CATEGORIES.forEach(cat => {
    elements.editCategory1.add(new Option(cat, cat));
    elements.editCategory2.add(new Option(cat, cat));
});

let appState = {
    isJobRunning: false,
    hasUnsavedChanges: false, // Optional: if we want to track form edits before save
    files: [], // Array of objects: { filename, status, title, description, keywords, categories, error }
    currentPage: 1,
    pageSize: 10,
    jobComplete: false,
    searchQuery: '',
    upload: {
        isUploading: false,
        uploaded: 0,
        failed: 0,
        total: 0,
        currentFile: '',
        errors: [],
        done: false,
    }
};

let eventSource = null;

// Initialize
async function init() {
    try {
        const response = await fetch('/api/status');
        const data = await response.json();

        appState.isJobRunning = data.job_running;
        elements.fileCount.textContent = data.raw_count;

        if (data.current_results && data.current_results.length > 0) {
            // Restore state from backend
            appState.files = data.current_results;
            if (appState.isJobRunning) {
                showTableView(true);
                connectSSE();
            } else {
                // Job already complete, restore to table view
                appState.jobComplete = true;
                showTableView(false);
            }
        } else {
            if (data.raw_count > 0 && !appState.isJobRunning) {
                elements.startBtn.disabled = false;
            }
            // Initialize files array for pending state
            if (data.files && !appState.isJobRunning) {
                appState.files = data.files.map(f => ({ filename: f, status: 'pending' }));
            }
        }

        // ── Restore upload progress state ──────────────────────────────────
        const up = data.upload_progress;
        if (up && up.total > 0) {
            appState.upload = {
                isUploading: !!data.upload_running,
                uploaded: up.uploaded || 0,
                failed:   up.failed  || 0,
                total:    up.total   || 0,
                currentFile: up.current_file || '',
                errors:   up.errors  || [],
                done:     up.done    || false,
            };

            // Ensure the table view is visible (upload can only happen post-processing)
            if (elements.tableView.classList.contains('hidden')) {
                appState.jobComplete = true;
                showTableView(false);
            }

            // Render the progress bar with the last known state
            renderUploadProgress();

            // If upload was still running when the page was refreshed, reconnect SSE
            if (data.upload_running && (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
                connectSSE();
            }

            // If the upload completed fully, suppress the upload button — output/ is empty
            if (up.done && up.failed === 0) {
                elements.uploadBtn.classList.add('hidden');
            }
        }

    } catch (e) {
        console.error('Failed to init:', e);
        elements.startError.textContent = 'Backend is not reachable.';
    }
}

// UI Transitions
function setHeaderStatus(running) {
    if (running) {
        elements.pulseDot.classList.add('running');
        elements.statusText.textContent = 'Processing...';
    } else {
        elements.pulseDot.classList.remove('running');
        elements.statusText.textContent = appState.jobComplete ? 'Completed' : 'Ready';
    }

    if (appState.jobComplete) {
        elements.clearBtn.classList.remove('hidden');
        // Show upload button only if there are successfully processed files
        const hasSuccessFiles = appState.files.some(f => f.status === 'success');
        if (hasSuccessFiles) {
            elements.uploadBtn.classList.remove('hidden');
        }
    } else {
        elements.clearBtn.classList.add('hidden');
        elements.uploadBtn.classList.add('hidden');
    }
}

function showTableView(running = false) {
    elements.launchView.classList.add('hidden');
    elements.tableView.classList.remove('hidden');
    setHeaderStatus(running);
    renderTable();
}

// Table Rendering
function renderTable() {
    elements.tableBody.innerHTML = '';

    // Apply filename filter
    const query = appState.searchQuery.toLowerCase();
    const filtered = query
        ? appState.files.filter(f => f.filename.toLowerCase().includes(query))
        : appState.files;

    const startIdx = (appState.currentPage - 1) * appState.pageSize;
    const endIdx = startIdx + appState.pageSize;
    const paginated = filtered.slice(startIdx, endIdx);

    if (paginated.length === 0) {
        const msg = query ? `No files matching "${query}"` : 'No files to show';
        elements.tableBody.innerHTML = `<tr><td colspan="7" style="text-align:center; color:var(--text-secondary); padding:2rem 0">${msg}</td></tr>`;
        // Still update pagination below so totals reflect the empty state
    }

    paginated.forEach(file => {
        const tr = document.createElement('tr');

        let statusHtml = `<span class="status-badge status-${file.status}">${file.status}</span>`;
        if (file.status === 'failed') {
            statusHtml += `<div style="color:var(--danger); font-size:11px; margin-top:4px" title="${file.error || ''}">${(file.error || '').substring(0, 30)}...</div>`;
        }

        const isEditable = appState.jobComplete && file.status === 'success';

        tr.innerHTML = `
            <td>
                <div class="cell-content">
                    <img src="/processing/${file.filename}" alt="${file.filename}" class="thumbnail" onerror="this.style.display='none'">
                </div>
            </td>
            <td>${statusHtml}</td>
            <td title="${file.title || '-'}"><div class="cell-content">${file.title || '-'}</div></td>
            <td title="${file.description || '-'}"><div class="cell-content">${file.description || '-'}</div></td>
            <td title="${Array.isArray(file.keywords) ? file.keywords.join(', ') : (file.keywords || '-')}">
                <div class="cell-content">${Array.isArray(file.keywords) ? file.keywords.join(', ') : (file.keywords || '-')}</div>
            </td>
            <td title="${Array.isArray(file.categories) ? file.categories.join(', ') : (file.categories || '-')}">
                <div class="cell-content">${Array.isArray(file.categories) ? file.categories.join(', ') : (file.categories || '-')}</div>
            </td>
            <td>
                <button class="action-btn" onclick="openEditModal('${file.filename}')" ${isEditable ? '' : 'disabled'}>
                    Edit
                </button>
            </td>
        `;
        elements.tableBody.appendChild(tr);
    });

    // Update pagination info (based on filtered set)
    const query2 = appState.searchQuery.toLowerCase();
    const filteredForPage = query2
        ? appState.files.filter(f => f.filename.toLowerCase().includes(query2))
        : appState.files;
    const totalPages = Math.ceil(filteredForPage.length / appState.pageSize) || 1;
    elements.pageInfo.textContent = `Page ${appState.currentPage} of ${totalPages}`;
    elements.prevPage.disabled = appState.currentPage === 1;
    elements.nextPage.disabled = appState.currentPage === totalPages;

    // Update progress text
    const completed = appState.files.filter(f => f.status === 'success' || f.status === 'failed').length;
    const failed = appState.files.filter(f => f.status === 'failed').length;
    elements.progressText.textContent = `${completed} / ${appState.files.length} Processed`;
    if (failed > 0) {
        elements.errorCount.textContent = `${failed} Error${failed > 1 ? 's' : ''}`;
        elements.errorCount.classList.remove('hidden');
    } else {
        elements.errorCount.classList.add('hidden');
    }

    // Update document title with live progress
    if (appState.isJobRunning) {
        document.title = `ShutterScribe | Progress (${completed}/${appState.files.length})`;
    }
}

// SSE Connection
function connectSSE() {
    if (eventSource) eventSource.close();

    eventSource = new EventSource('/api/stream');

    eventSource.onmessage = (event) => {
        // Starlette SSE events without an 'event' type come as 'message'
        try {
            const data = JSON.parse(event.data);
            handleSSEData(null, data);
        } catch (e) {
            console.warn("Couldn't parse message event", event.data);
        }
    };

    eventSource.addEventListener('status_update', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('status_update', data);
    });

    eventSource.addEventListener('job_complete', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('job_complete', data);
    });

    eventSource.addEventListener('job_error', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('job_error', data);
    });

    eventSource.addEventListener('upload_progress', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('upload_progress', data);
    });

    eventSource.addEventListener('upload_complete', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('upload_complete', data);
    });

    eventSource.addEventListener('upload_error', (e) => {
        const data = JSON.parse(e.data);
        handleSSEData('upload_error', data);
    });

    eventSource.onerror = (err) => {
        console.error("SSE Error:", err);
    };
}

function handleSSEData(type, data) {
    if (type === 'status_update') {
        const fileObj = appState.files.find(f => f.filename === data.filename);
        if (fileObj) {
            fileObj.status = data.status;
            if (data.status === 'success') {
                fileObj.title = data.title;
                fileObj.description = data.description;
                fileObj.keywords = data.keywords;
                fileObj.categories = data.categories;
            } else if (data.status === 'failed') {
                fileObj.error = data.error_message;
            }
            renderTable();
        } else {
            // New file that wasn't in the initial list? Add it.
            appState.files.push({ ...data, keywords: data.keywords || [], categories: data.categories || [] });
            renderTable();
        }
    } else if (type === 'job_complete') {
        appState.isJobRunning = false;
        appState.jobComplete = true;
        document.title = 'ShutterScribe';
        setHeaderStatus(false);
        renderTable(); // Re-render to enable edit buttons
        // Keep SSE connection alive — we need it for upload_progress events
        alert('Processing completed!');
    } else if (type === 'job_error') {
        appState.isJobRunning = false;
        setHeaderStatus(false);
        alert('Job failed: ' + data.error);
        eventSource.close();
        eventSource = null;
    } else if (type === 'upload_progress') {
        appState.upload.isUploading = true;
        appState.upload.total = data.total;
        appState.upload.uploaded = data.uploaded;
        appState.upload.failed = data.failed;
        appState.upload.currentFile = data.filename;
        if (data.status === 'failed' && data.error) {
            appState.upload.errors.push({ filename: data.filename, error: data.error });
        }
        renderUploadProgress();
    } else if (type === 'upload_complete') {
        appState.upload.isUploading = false;
        appState.upload.done = true;
        appState.upload.total = data.total;
        appState.upload.uploaded = data.uploaded;
        appState.upload.failed = data.failed;
        appState.upload.errors = data.errors || [];
        appState.upload.currentFile = '';
        renderUploadProgress();
        elements.uploadBtn.disabled = false;
        elements.uploadBtn.classList.remove('uploading');
        // Hide upload button — output dir has been cleared
        elements.uploadBtn.classList.add('hidden');
        // Now we can safely close the SSE stream
        if (eventSource) { eventSource.close(); eventSource = null; }
    } else if (type === 'upload_error') {
        appState.upload.isUploading = false;
        appState.upload.done = true;
        appState.upload.currentFile = '';
        renderUploadProgress(true, data.error);
        elements.uploadBtn.disabled = false;
        elements.uploadBtn.classList.remove('uploading');
        // Leave SSE open so the user can retry
    }
}

// Upload Progress Rendering
function renderUploadProgress(fatalError = false, fatalMessage = '') {
    const { total, uploaded, failed, currentFile, done, errors } = appState.upload;

    // Show the section
    elements.uploadProgressSection.classList.remove('hidden');

    const fill = elements.uploadProgressFill;
    const statusText = elements.uploadStatusText;
    const errorBadge = elements.uploadErrorCount;

    // Determine fill width
    const pct = total > 0 ? Math.round(((uploaded + failed) / total) * 100) : 0;
    fill.style.width = `${pct}%`;

    // Update fill appearance
    fill.classList.remove('done', 'has-errors', 'all-failed');
    if (done) {
        if (fatalError) {
            fill.classList.add('all-failed');
        } else if (uploaded === 0 && failed > 0) {
            fill.classList.add('all-failed');
        } else if (failed > 0) {
            fill.classList.add('has-errors');
        } else {
            fill.classList.add('done');
        }
    }

    // Status text
    if (fatalError) {
        statusText.textContent = `Upload failed: ${fatalMessage}`;
        statusText.style.color = 'var(--danger)';
    } else if (done) {
        if (uploaded === 0 && failed > 0) {
            statusText.textContent = `Upload failed — all ${failed} file${failed !== 1 ? 's' : ''} could not be uploaded.`;
            statusText.style.color = '#f87171';
        } else if (failed > 0) {
            statusText.textContent = `Upload complete — ${uploaded} uploaded, ${failed} failed.`;
            statusText.style.color = '#fbbf24';
        } else {
            statusText.textContent = `✓ All ${uploaded} image${uploaded !== 1 ? 's' : ''} uploaded successfully.`;
            statusText.style.color = '#34d399';
        }
    } else if (!currentFile) {
        statusText.textContent = 'Connecting to Shutterstock…';
        statusText.style.color = '';
    } else {
        statusText.textContent = `Uploading ${uploaded + failed} / ${total} — ${currentFile}`;
        statusText.style.color = '';
    }

    // Error badge
    if (failed > 0) {
        errorBadge.textContent = `${failed} Error${failed !== 1 ? 's' : ''}`;
        errorBadge.classList.remove('hidden');
    } else {
        errorBadge.classList.add('hidden');
    }
}

// Actions
elements.startBtn.addEventListener('click', async () => {
    elements.startBtn.disabled = true;
    elements.startError.textContent = '';

    try {
        const res = await fetch('/api/start', { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message);
        }
        showTableView();
        connectSSE();
    } catch (e) {
        elements.startError.textContent = e.message;
        elements.startBtn.disabled = false;
    }
});

elements.prevPage.addEventListener('click', () => {
    if (appState.currentPage > 1) {
        appState.currentPage--;
        renderTable();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
});

elements.nextPage.addEventListener('click', () => {
    const query = appState.searchQuery.toLowerCase();
    const filtered = query ? appState.files.filter(f => f.filename.toLowerCase().includes(query)) : appState.files;
    const totalPages = Math.ceil(filtered.length / appState.pageSize);
    if (appState.currentPage < totalPages) {
        appState.currentPage++;
        renderTable();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
});

// Search
elements.searchInput.addEventListener('input', () => {
    const raw = elements.searchInput.value.trim();
    // Only filter once the user has typed at least 3 characters
    appState.searchQuery = raw.length >= 3 ? raw : '';
    appState.currentPage = 1;
    if (raw.length > 0) {
        elements.searchClear.classList.remove('hidden');
    } else {
        elements.searchClear.classList.add('hidden');
    }
    renderTable();
});

elements.searchClear.addEventListener('click', () => {
    elements.searchInput.value = '';
    appState.searchQuery = '';
    appState.currentPage = 1;
    elements.searchClear.classList.add('hidden');
    elements.searchInput.focus();
    renderTable();
});

elements.clearBtn.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear the current run? This will delete processing images.')) {
        return;
    }

    elements.clearBtn.disabled = true;
    try {
        const res = await fetch('/api/clear', { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message);
        }

        // Reset state and return to launch view
        appState.files = [];
        appState.jobComplete = false;
        appState.upload = { isUploading: false, uploaded: 0, failed: 0, total: 0, currentFile: '', errors: [], done: false };
        document.title = 'ShutterScribe';
        elements.tableView.classList.add('hidden');
        elements.launchView.classList.remove('hidden');
        elements.uploadProgressSection.classList.add('hidden');
        setHeaderStatus(false);
        // Close SSE on clear
        if (eventSource) { eventSource.close(); eventSource = null; }
        init(); // Re-fetch initial status to update raw_count
    } catch (e) {
        alert(e.message);
    } finally {
        elements.clearBtn.disabled = false;
    }
});

elements.uploadBtn.addEventListener('click', async () => {
    if (appState.upload.isUploading) return;

    // Reset upload state for a fresh run
    appState.upload = { isUploading: true, uploaded: 0, failed: 0, total: 0, currentFile: '', errors: [], done: false };

    // Show progress bar immediately in connecting state
    elements.uploadProgressSection.classList.remove('hidden');
    elements.uploadProgressFill.style.width = '0%';
    elements.uploadProgressFill.classList.remove('done', 'has-errors', 'all-failed');
    elements.uploadStatusText.textContent = 'Connecting to Shutterstock…';
    elements.uploadStatusText.style.color = '';
    elements.uploadErrorCount.classList.add('hidden');

    elements.uploadBtn.disabled = true;
    elements.uploadBtn.classList.add('uploading');

    // Ensure SSE is connected before starting — it may have been closed after an error
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
        connectSSE();
    }

    try {
        const res = await fetch('/api/upload/start', { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message);
        }
        // SSE events will drive the rest of the progress rendering
    } catch (e) {
        // Immediate failure (e.g. already uploading, or network error)
        appState.upload.isUploading = false;
        appState.upload.done = true;
        renderUploadProgress(true, e.message);
        elements.uploadBtn.disabled = false;
        elements.uploadBtn.classList.remove('uploading');
    }
});

// Editing
window.openEditModal = function (filename) {
    const fileObj = appState.files.find(f => f.filename === filename);
    if (!fileObj) return;

    elements.editFilename.textContent = filename;
    elements.editImagePreview.src = `/processing/${filename}`;
    elements.editTitle.value = fileObj.title || '';
    elements.editDescription.value = fileObj.description || '';
    elements.editKeywords.value = Array.isArray(fileObj.keywords) ? fileObj.keywords.join(', ') : fileObj.keywords;

    const cats = Array.isArray(fileObj.categories) ? fileObj.categories : (fileObj.categories || '').split(',').map(s => s.trim());
    elements.editCategory1.value = cats[0] || STOCK_CATEGORIES[0];
    elements.editCategory2.value = cats[1] || "";

    elements.saveError.textContent = '';
    elements.editModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

function closeEditModal() {
    elements.editModal.classList.add('hidden');
    document.body.style.overflow = '';
}

elements.closeModal.addEventListener('click', closeEditModal);
elements.cancelEdit.addEventListener('click', closeEditModal);

elements.saveEdit.addEventListener('click', async () => {
    elements.saveError.textContent = '';
    const filename = elements.editFilename.textContent;

    const c1 = elements.editCategory1.value;
    const c2 = elements.editCategory2.value;
    const finalCats = (c2 && c2 !== c1) ? `${c1}, ${c2}` : c1;

    const payload = {
        filename: filename,
        title: elements.editTitle.value,
        description: elements.editDescription.value,
        keywords: elements.editKeywords.value,
        categories: finalCats
    };

    try {
        const origBtnText = elements.saveEdit.textContent;
        elements.saveEdit.textContent = 'Saving...';
        elements.saveEdit.disabled = true;

        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.message);
        }

        // Update local state
        const fileObj = appState.files.find(f => f.filename === filename);
        if (fileObj) {
            fileObj.title = payload.title;
            fileObj.description = payload.description;
            // Converting comma-separated strings back to arrays for state
            fileObj.keywords = payload.keywords.split(',').map(s => s.trim());
            fileObj.categories = payload.categories.split(',').map(s => s.trim());
            renderTable();
        }

        // Mark unsaved changes flag just to trigger beforeunload logic for testing, 
        // actually if we saved it successfully, we don't have "unsaved" changes here,
        // wait, the prompt says "System warns of unsaved changes if trying to close the app."
        // We will set this to true if the user edits the input and then tries to close.
        appState.hasUnsavedChanges = false;

        closeEditModal();
    } catch (e) {
        elements.saveError.textContent = e.message;
    } finally {
        elements.saveEdit.textContent = 'Save Changes';
        elements.saveEdit.disabled = false;
    }
});

// Track changes in the modal to warn user
elements.editForm.addEventListener('input', () => {
    appState.hasUnsavedChanges = true;
});

window.addEventListener('beforeunload', (e) => {
    if (appState.hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = ''; // Standard behavior for modern browsers
    }
});

// Kickoff
init();
