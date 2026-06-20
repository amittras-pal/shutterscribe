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
    searchInput: document.getElementById('search-input'),
    searchClear: document.getElementById('search-clear'),

    prevPage: document.getElementById('prev-page'),
    nextPage: document.getElementById('next-page'),
    pageInfo: document.getElementById('page-info'),

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

const SHUTTERSTOCK_CATEGORIES = [
    "Abstract", "Animals/Wildlife", "Arts", "Backgrounds/Textures",
    "Beauty/Fashion", "Buildings/Landmarks", "Business/Finance",
    "Celebrities", "Education", "Food and drink", "Healthcare/Medical",
    "Holidays", "Industrial", "Interiors", "Miscellaneous", "Nature",
    "Objects", "Parks/Outdoor", "People", "Religion", "Science",
    "Signs", "Sports/Recreation", "Technology", "Transportation", "Vintage"
];

// Initialize category options
SHUTTERSTOCK_CATEGORIES.forEach(cat => {
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
    searchQuery: ''
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
                showTableView();
                connectSSE();
            } else {
                // Job already complete, restore to table view
                appState.jobComplete = true;
                showTableView();
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
    } else {
        elements.clearBtn.classList.add('hidden');
    }
}

function showTableView() {
    elements.launchView.classList.add('hidden');
    elements.tableView.classList.remove('hidden');
    setHeaderStatus(true);
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
        setHeaderStatus(false);
        renderTable(); // Re-render to enable edit buttons
        eventSource.close();
        alert('Processing completed!');
    } else if (type === 'job_error') {
        appState.isJobRunning = false;
        setHeaderStatus(false);
        alert('Job failed: ' + data.error);
        eventSource.close();
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
    }
});

elements.nextPage.addEventListener('click', () => {
    const query = appState.searchQuery.toLowerCase();
    const filtered = query ? appState.files.filter(f => f.filename.toLowerCase().includes(query)) : appState.files;
    const totalPages = Math.ceil(filtered.length / appState.pageSize);
    if (appState.currentPage < totalPages) {
        appState.currentPage++;
        renderTable();
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
        elements.tableView.classList.add('hidden');
        elements.launchView.classList.remove('hidden');
        setHeaderStatus(false);
        init(); // Re-fetch initial status to update raw_count
    } catch (e) {
        alert(e.message);
    } finally {
        elements.clearBtn.disabled = false;
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
    elements.editCategory1.value = cats[0] || SHUTTERSTOCK_CATEGORIES[0];
    elements.editCategory2.value = cats[1] || "";

    elements.saveError.textContent = '';
    elements.editModal.classList.remove('hidden');
};

function closeEditModal() {
    elements.editModal.classList.add('hidden');
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
