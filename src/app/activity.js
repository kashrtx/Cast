// The record of what changed and what failed.
//
// Every entry the log shows is written from here, and the panel in Settings is drawn from here. The
// list itself and its rules are in src/activitylog.js.
//
// This is worth keeping tidy because it is what someone pastes when they ask for help. If you add a
// feature that changes or deletes anything, record it, and record the failure too.

// Writes down what just happened.
//
// Called from the places that change your data, so the log in Settings is a real record
// rather than a guess. Saving is put off for a moment so a burst of changes does not
// mean a burst of writes.
// Safe to call at any point, including before the log has been read from storage and from inside an
// error handler. A failure while recording a failure would be a poor way to lose the record of it.
function recordActivityIfReady(kind, detail) {
    try {
        if (!state || !Array.isArray(state.activityLog)) return;
        recordActivity(kind, detail);
    } catch (error) {
        console.warn('Could not record that in the log:', error);
    }
}

function recordActivity(kind, detail) {
    state.activityLog = CastLog.append(state.activityLog, kind, detail);

    if (state.logSaveTimer) clearTimeout(state.logSaveTimer);
    state.logSaveTimer = setTimeout(() => {
        castStore.write(CastStorage.KEYS.ACTIVITY_LOG, state.activityLog);
    }, 1500);

    // Anything on screen that reports recent activity should follow along.
    if (typeof updateLastBackupStatus === "function") updateLastBackupStatus();
    if (typeof renderActivityLog === "function") renderActivityLog();
}

// Counts activity so the backup reminder knows whether there is anything worth
// saving. Deliberately cheap, since it runs on every write.
function noteDataChanged(count) {
    // A search result must never be based on messages that have since changed.
    if (typeof clearChatSearchCache === 'function') clearChatSearchCache();

    if (!state.backupState) return;
    state.backupState = CastBackup.recordChange(state.backupState, count);
    // Keep the visible line in step with reality.
    if (typeof updateLastBackupStatus === "function") updateLastBackupStatus();
    if (state.backupSaveTimer) clearTimeout(state.backupSaveTimer);
    state.backupSaveTimer = setTimeout(() => {
        castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
    }, 2000);
}

// Draws the activity log. Newest first, one line each, timestamped to the second so it
// can be lined up with when you remember doing something.
function renderActivityLog() {
    const panel = document.getElementById('activity-log');
    const entries = CastLog.newestFirst(state.activityLog);

    // The summary shows even when the log itself is collapsed.
    const summary = document.getElementById('activity-log-summary');
    if (summary) {
        const failures = entries.filter(entry => /fail/i.test(entry.kind)).length;
        summary.textContent = failures
            ? `${entries.length} entries, ${failures} ${failures === 1 ? 'failure' : 'failures'}`
            : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
        summary.className = failures ? 'text-xs text-red-600 font-medium' : 'text-xs text-gray-500';
    }

    if (!panel || panel.classList.contains('hidden')) return;

    if (!entries.length) {
        panel.innerHTML = '<p class="text-gray-500">Nothing recorded yet.</p>';
        return;
    }

    const lastBackupAt = state.backupState ? state.backupState.lastBackupAt : null;

    const shown = showOnlyFailures ? CastLog.failuresOnly(state.activityLog) : entries;

    if (!shown.length) {
        panel.innerHTML = showOnlyFailures
            ? '<p class="text-gray-500">No failures recorded. That is the good outcome.</p>'
            : '<p class="text-gray-500">Nothing recorded yet.</p>';
        return;
    }

    panel.innerHTML = shown.map(entry => {
        const level = entry.level || CastLog.levelOf(entry.kind);
        const isSinceBackup = lastBackupAt && String(entry.at) > String(lastBackupAt);

        const detail = entry.detail
            ? ` <span class="log-detail">${CastEscape.escapeHtml(entry.detail)}</span>`
            : '';

        return `<div class="log-line log-${level}${isSinceBackup ? ' log-recent' : ''}">`
            + `<span class="log-time">${CastEscape.escapeHtml(CastLog.formatTime(entry.at))}</span>`
            + `<span class="log-kind">${CastEscape.escapeHtml(entry.kind)}</span>`
            + detail
            + `</div>`;
    }).join('');
}

// Whether the log is filtered to failures.
let showOnlyFailures = false;

function setupActivityLogToggle() {
    const failuresBtn = document.getElementById('activity-log-failures');
    if (failuresBtn) {
        failuresBtn.addEventListener('click', () => {
            showOnlyFailures = !showOnlyFailures;
            failuresBtn.textContent = showOnlyFailures ? 'Show everything' : 'Failures only';
            failuresBtn.className = showOnlyFailures
                ? 'text-xs text-primary font-semibold underline'
                : 'text-xs text-gray-600 hover:text-primary underline';
            renderActivityLog();
        });
    }

    // Copying the whole log matters because the useful thing to do with a log is give it to
    // somebody who can read it.
    const copyBtn = document.getElementById('activity-log-copy');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const header = [
                `${CastBrand.name} ${CastBrand.appVersion}`,
                `Provider: ${getProviderDisplayName()}, model ${getModelFor()}`,
                `Page: ${window.location.origin || 'opened from a file'}`,
                `Proxy: ${getProxyUrl() || 'none'}`,
                '',
            ].join('\n');

            const text = header + CastLog.asText(state.activityLog);

            try {
                await navigator.clipboard.writeText(text);
                notify('Log copied, including which provider and version you are on.', 'success');
            } catch (error) {
                // Clipboard access can be refused, so fall back to selecting it for copying by hand.
                const panel = document.getElementById('activity-log');
                if (panel) {
                    const range = document.createRange();
                    range.selectNodeContents(panel);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                    notify('Could not reach the clipboard, so the log has been selected for you to copy.', 'warning');
                } else {
                    notify(`Could not copy: ${error.message}`, 'error');
                }
            }
        });
    }

    const button = document.getElementById('activity-log-toggle');
    const panel = document.getElementById('activity-log');
    const chevron = document.getElementById('activity-log-chevron');
    const label = document.getElementById('activity-log-label');
    if (!button || !panel) return;

    button.addEventListener('click', () => {
        const nowOpen = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !nowOpen);
        if (chevron) chevron.className = `fas fa-chevron-${nowOpen ? 'down' : 'right'} text-xs`;
        if (label) label.textContent = nowOpen ? 'Hide' : 'Show';
        if (nowOpen) renderActivityLog();
    });

    // Open to begin with. It used to be behind a small link inside another card, which made
    // the first place to look when something goes wrong the hardest thing to find.
    renderActivityLog();

    // The longer explanation under the summarising setting, kept out of the way until
    // asked for, because that block had grown into an essay.
    const moreLink = document.getElementById('memory-more-link');
    const more = document.getElementById('memory-more');
    if (moreLink && more) {
        moreLink.addEventListener('click', (e) => {
            e.preventDefault();
            const nowOpen = more.classList.contains('hidden');
            more.classList.toggle('hidden', !nowOpen);
            moreLink.textContent = nowOpen ? 'Hide this' : 'Why this happens';
        });
    }
}
