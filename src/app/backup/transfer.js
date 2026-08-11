// Taking everything out as a file, and putting it back.
//
// Everything is in the browser, which means it is one cleared cache away from gone. Export writes
// characters, chats, history, settings and pictures to a single file. Import reads that file, and
// also every older shape the app has written, which is why loading is more code than saving.
//
// A key is only ever included if you asked for it. Filenames and the reading of old files are in
// src/backup.js, tested against a real file from 2025.

// Export app data to a JSON file
// Saves a backup file.
//
// Pictures need care here. They are not stored on the character records any more,
// they live in their own store, so this has to go and fetch them and put them
// back onto the records for the file. Without that step a backup looks complete
// and quietly contains no pictures at all, which is exactly what happened in
// version 2.0.0.
//
// The file format deliberately embeds pictures the same way every older version
// did. That means one import path handles files of any age, and a backup written
// today can still be opened by an older copy of the app.
async function exportAppData() {
    const exportButton = document.getElementById('export-data-btn');
    const originalLabel = exportButton ? exportButton.innerHTML : '';

    try {
        if (exportButton) {
            exportButton.disabled = true;
            exportButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing...';
        }

        // Fetch the pictures and put them back on the character records for the
        // file. state.characters is not modified, only the copy being saved.
        let pictures = {};
        let pictureProblem = "";
        try {
            pictures = await CastImages.getAllPictures();
        } catch (error) {
            console.error("Pictures could not be read for the backup:", error);
            pictureProblem = " Pictures could not be read, so this file does not contain them.";
        }

        const charactersForFile = (state.characters || []).map(character => {
            if (!character || typeof character !== 'object') return character;
            const copy = Object.assign({}, character);
            const picture = pictures[character.id]
                || (typeof character.profilePicture === 'string' ? character.profilePicture : '');
            if (picture) {
                copy.profilePicture = picture;
                copy.hasPicture = true;
            } else {
                delete copy.profilePicture;
                // Do not claim a picture the file does not carry.
                if (copy.hasPicture) delete copy.hasPicture;
            }
            return copy;
        });

        // Check the file really does carry what it claims before writing it.
        const expected = (state.characters || []).filter(c => c && (c.hasPicture || c.profilePicture)).length;
        const included = charactersForFile.filter(c => c && c.profilePicture).length;
        if (expected > included && !pictureProblem) {
            pictureProblem = ` ${expected - included} of ${expected} pictures could not be found, so they are not in this file.`;
        }

        const data = {
            characters: charactersForFile,
            chats: state.chats,
            chatHistory: state.chatHistory,
            lastActiveChats: state.lastActiveChats,
            chatMembers: state.chatMembers,
            settings: appSettings,
            personalContext: state.personalContext,
            apiKeys: appSettings.apiKeys || {},
        };

        const includeKey = Boolean(appSettings.includeKeyInBackups);
        const payload = CastBackup.buildExport({
            data,
            brand: CastBrand,
            includeApiKey: includeKey,
        });

        const counts = CastBackup.summarise(data);
        const filename = CastBackup.buildFilename({
            slug: CastBrand.fileSlug,
            when: new Date(),
            characterCount: counts.characterCount,
            chatCount: counts.chatCount,
            messageCount: counts.messageCount,
        });

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;

        document.body.appendChild(link);
        link.click();

        setTimeout(() => {
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 100);

        // Reset the reminder, since there is now a fresh backup.
        state.backupState = CastBackup.recordBackupTaken(state.backupState);
        castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
        recordActivity(CastLog.KINDS.BACKUP_SAVED, filename);
        hideBackupReminder();
        updateLastBackupStatus();

        const keyNote = includeKey ? ' It contains your API keys, so keep it private.' : '';
        const pictureNote = included ? ` Includes ${included} ${included === 1 ? 'picture' : 'pictures'}.` : '';

        if (pictureProblem) {
            showError(`Saved ${filename}, but${pictureProblem}`);
        } else {
            showSuccess(`Saved ${filename}.${pictureNote}${keyNote}`, 6000);
        }
    } catch (error) {
        console.error("Could not save a backup:", error);
        showError(`The backup could not be saved: ${error.message}`);
    } finally {
        if (exportButton) {
            exportButton.disabled = false;
            exportButton.innerHTML = originalLabel;
        }
    }
}

// Loads a backup file.
//
// The old version wrote each key straight over your data with no checking and no
// way back. If one write failed partway through, for example because there was
// no room left, you were left holding characters from the new file and chats from
// the old one, which is the mismatched state that used to trigger the history
// deletion on the next reload.
//
// Now the file is checked first, a snapshot of your current data is taken before
// anything is touched, and if any part of the write fails the snapshot is put
// back.
function importAppData() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();

        reader.onload = async (loadEvent) => {
            try {
                let raw;
                try {
                    raw = JSON.parse(loadEvent.target.result);
                } catch (parseError) {
                    throw new Error("That file is not valid JSON, so it cannot be read.");
                }

                // Check the file before touching anything.
                const checked = CastBackup.normaliseImport(raw);
                if (!checked.ok) {
                    throw new Error(checked.problems.join(' '));
                }

                const incoming = checked.summary;
                const current = CastBackup.summarise({
                    characters: state.characters,
                    chats: state.chats,
                });

                const confirmMessage = [
                    `This file holds ${incoming.characterCount} characters, ${incoming.chatCount} chats and ${incoming.messageCount} messages.`,
                    ``,
                    `It will replace what is here now, which is ${current.characterCount} characters, ${current.chatCount} chats and ${current.messageCount} messages.`,
                    ``,
                    `Continue?`,
                ].join('\n');

                if (!confirm(confirmMessage)) return;

                // Take a snapshot so there is something to go back to.
                const snapshotSaved = CastStorage.saveSnapshot(castStore, {
                    characters: state.characters,
                    chats: state.chats,
                    chatHistory: state.chatHistory,
                    lastActiveChats: state.lastActiveChats,
                    chatMembers: state.chatMembers,
                });

                if (!snapshotSaved.ok) {
                    const proceed = confirm(
                        "There was not enough room to save a copy of your current data first, so this cannot be undone if it goes wrong. Continue anyway?"
                    );
                    if (!proceed) return;
                }

                const imported = checked.data;

                // Move any pictures embedded in the file out of the way before
                // writing, so they cannot fill up the space the chats need.
                let pictureNote = '';
                try {
                    const migration = await CastImages.migrateEmbeddedPictures(imported.characters);
                    imported.characters = migration.characters;
                    if (migration.moved) {
                        const saved = migration.bytesBefore - migration.bytesAfter;
                        pictureNote = ` ${migration.moved} pictures were moved out of the crowded storage area`;
                        pictureNote += saved > 0 ? ` and shrunk, saving ${formatBytes(saved)}.` : '.';
                    }
                } catch (pictureError) {
                    console.warn("Pictures could not be moved, leaving them where they are:", pictureError);
                }

                // Repair the history grouping if the file came from a version that
                // filed it under a key with a timestamp glued on.
                const repaired = CastBackup.repairHistoryGrouping(imported.chatHistory, imported.characters);
                if (repaired.movedGroups) {
                    Object.keys(repaired.chatMembers).forEach(chatId => {
                        if (!imported.chatMembers[chatId]) {
                            imported.chatMembers[chatId] = repaired.chatMembers[chatId];
                        }
                    });
                    imported.chatHistory = repaired.chatHistory;
                }

                // Write everything, keeping track so we can undo on failure.
                const writes = [
                    [STORAGE_KEYS.CHARACTERS, imported.characters],
                    [STORAGE_KEYS.CHATS, imported.chats],
                    [STORAGE_KEYS.CHAT_HISTORY, imported.chatHistory],
                    [STORAGE_KEYS.LAST_ACTIVE_CHATS, imported.lastActiveChats],
                    [CastStorage.KEYS.CHAT_MEMBERS, imported.chatMembers],
                    [STORAGE_KEYS.PERSONAL_CONTEXT, imported.personalContext],
                ];

                const failed = [];
                writes.forEach(([key, value]) => {
                    const result = castStore.write(key, value);
                    if (!result.ok) failed.push({ key, reason: result.reason });
                });

                // Settings need care, because the file may be old. Merge rather
                // than replace, then bring the shape up to date.
                if (imported.settings && Object.keys(imported.settings).length) {
                    appSettings = { ...appSettings, ...imported.settings };
                }
                if (Object.keys(imported.apiKeys).length) {
                    appSettings.apiKeys = { ...(appSettings.apiKeys || {}), ...imported.apiKeys };
                    if (imported.apiKeys.gemini) {
                        state.apiKey = imported.apiKeys.gemini;
                        castStore.write(STORAGE_KEYS.API_KEY, state.apiKey);
                    }
                }

                if (failed.length) {
                    // Put things back the way they were.
                    const snapshot = CastStorage.readSnapshot(castStore);
                    if (snapshot) {
                        castStore.write(STORAGE_KEYS.CHARACTERS, snapshot.characters);
                        castStore.write(STORAGE_KEYS.CHATS, snapshot.chats);
                        castStore.write(STORAGE_KEYS.CHAT_HISTORY, snapshot.chatHistory);
                        castStore.write(STORAGE_KEYS.LAST_ACTIVE_CHATS, snapshot.lastActiveChats);
                        castStore.write(CastStorage.KEYS.CHAT_MEMBERS, snapshot.chatMembers);
                        throw new Error(
                            "There was not enough room for that backup, so nothing was changed and your existing data has been put back. Try removing some characters or pictures first."
                        );
                    }
                    throw new Error(
                        "Part of that backup could not be written and your previous data could not be restored. Save a backup of whatever is here before doing anything else."
                    );
                }

                // Migrate the settings shape, then persist.
                migrateSettingsShape();
                castStore.write(STORAGE_KEYS.SETTINGS, appSettings);

                const problemNote = checked.problems.length
                    ? ` Some parts were skipped: ${checked.problems.slice(0, 3).join(' ')}`
                    : '';

                recordActivity(CastLog.KINDS.BACKUP_LOADED, `${incoming.characterCount} characters, ${incoming.chatCount} chats, ${incoming.messageCount} messages`);
                if (checked.problems.length) {
                    recordActivity(CastLog.KINDS.IMPORT_PROBLEM, checked.problems.slice(0, 3).join(' '));
                }

                showSuccess(`Loaded ${incoming.characterCount} characters and ${incoming.chatCount} chats.${pictureNote}${problemNote} Reloading...`, 4000);

                setTimeout(() => window.location.reload(), 2600);
            } catch (error) {
                console.error("Could not load that backup:", error);
                showError(error.message);
            }
        };

        reader.onerror = () => showError("That file could not be read.");
        reader.readAsText(file);
    });

    fileInput.click();
}
