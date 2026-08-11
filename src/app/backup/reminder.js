// A quiet nudge to take a backup.
//
// Timed from your last one and counted from how much has changed since, so it appears when there is
// something to lose rather than on a schedule. It can be dismissed and it does not come back
// straight away, because a reminder that will not take no for an answer gets ignored and then the
// real one is ignored too.

function loadBackupState() {
    const result = castStore.read(CastStorage.KEYS.BACKUP_STATE, "object");
    state.backupState = Object.assign({
        lastBackupAt: null,
        changesSinceBackup: 0,
        snoozedUntil: null,
    }, result.value || {});

    // Session fields are not persisted, so they start fresh every time.
    state.backupState.sessionStartedAt = new Date().toISOString();
    state.backupState.remindedThisSession = false;
}

function maybeShowBackupReminder() {
    if (!state.backupState) return;

    const verdict = CastBackup.shouldRemindAboutBackup(state.backupState);
    if (!verdict.remind) return;

    const banner = document.getElementById('backup-reminder');
    const message = document.getElementById('backup-reminder-message');
    if (!banner || !message) return;

    message.textContent = verdict.message;
    banner.classList.remove('hidden');

    state.backupState.remindedThisSession = true;
}

function hideBackupReminder() {
    const banner = document.getElementById('backup-reminder');
    if (banner) banner.classList.add('hidden');
}

function dismissBackupReminder() {
    state.backupState = CastBackup.snoozeReminder(state.backupState);
    castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
    hideBackupReminder();
}

function updateLastBackupStatus() {
    const element = document.getElementById('last-backup-status');
    if (!element || !state.backupState) return;
    // Recomputed whenever it is shown, and again whenever anything changes, because it
    // used to be written once at start up and then left to go stale. It would still say
    // no changes since the last backup after adding or deleting several characters.

    if (!state.backupState.lastBackupAt) {
        element.textContent = "You have not saved a backup yet.";
        return;
    }

    // Read from the log, so this describes what actually happened rather than relying on
    // a counter that was only updated in some of the places that change data.
    const summary = CastLog.summariseSince(state.activityLog, state.backupState.lastBackupAt);
    element.textContent = `Last backup ${CastLog.formatTime(state.backupState.lastBackupAt)}. ${summary}`;
}

// Checks every few minutes rather than on every keystroke, so it stays quiet.
function startBackupReminderTimer() {
    setInterval(maybeShowBackupReminder, 4 * 60 * 1000);
}
