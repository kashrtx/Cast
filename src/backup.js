// Backups.
//
// Three jobs here. Name the file so you can tell what is in it without opening
// it. Remind you to make one occasionally without becoming annoying. And import
// a file without the risk of ending up worse off than before you started.
//
// The old export wrote characterChatBackup_2025-06-02.json. Two exports on the
// same day collided, and the name told you nothing about what was inside.
//
// The old import wrote each key straight over the top of your data with no
// checking and no way back. If one of those writes failed partway through, for
// example because the pictures pushed it past the storage limit, you were left
// with characters from the new file and chats from the old one, which is exactly
// the mismatched state that used to trigger the history deletion.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastBackup = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const BACKUP_FORMAT = 2;

    function pad(value, width) {
        return String(value).padStart(width || 2, "0");
    }

    // Builds a filename that says what it is, when it was made, and how much is
    // inside. Sorting a folder of these by name also sorts them by date, which
    // is why the date leads and uses dashes.
    //
    // Example: cast-backup-2026-08-09-1432-09-chars-25-chats-745-messages.json
    function buildFilename({ slug, when, characterCount, chatCount, messageCount }) {
        const date = when instanceof Date ? when : new Date();
        const safeSlug = (slug || "cast").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

        const stamp = [
            date.getFullYear(),
            pad(date.getMonth() + 1),
            pad(date.getDate()),
        ].join("-");

        // Hours and minutes together, then seconds, so two backups a minute
        // apart are still clearly ordered and two in the same minute do not
        // collide.
        const clock = `${pad(date.getHours())}${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

        const counts = [
            `${characterCount || 0}-chars`,
            `${chatCount || 0}-chats`,
            `${messageCount || 0}-messages`,
        ].join("-");

        return `${safeSlug}-backup-${stamp}-${clock}-${counts}.json`;
    }

    // Counts what is in a set of data, for the filename and for the confirmation
    // message shown before an import replaces anything.
    function summarise(data) {
        const characters = Array.isArray(data && data.characters) ? data.characters : [];
        const chats = data && data.chats && typeof data.chats === "object" ? data.chats : {};

        let messageCount = 0;
        Object.keys(chats).forEach((chatId) => {
            const body = chats[chatId];
            if (Array.isArray(body)) messageCount += body.length;
        });

        return {
            characterCount: characters.length,
            chatCount: Object.keys(chats).length,
            messageCount,
        };
    }

    // Builds the object that gets written to the file.
    //
    // The key is left out unless it is explicitly asked for. The old export
    // always included it, which meant every backup file was a copy of your
    // credentials, and sharing one gave away your account.
    function buildExport({ data, brand, includeApiKey, when }) {
        const counts = summarise(data);
        const date = when instanceof Date ? when : new Date();

        const payload = {
            // Named so a human opening the file can see what it is.
            app: brand && brand.name ? brand.name : "Cast",
            backupFormat: BACKUP_FORMAT,
            appVersion: brand && brand.appVersion ? brand.appVersion : "",
            exportDate: date.toISOString(),
            contents: counts,

            characters: data.characters || [],
            chats: data.chats || {},
            chatHistory: data.chatHistory || {},
            lastActiveChats: data.lastActiveChats || {},
            chatMembers: data.chatMembers || {},
            settings: data.settings || {},
            personalContext: data.personalContext || {},
        };

        if (includeApiKey && data.apiKeys) {
            payload.apiKeys = data.apiKeys;
        }

        return payload;
    }

    // Reads a backup file of any age and returns it in the current shape.
    //
    // Every older layout is handled here. This is the promise that an old file
    // always opens.
    function normaliseImport(raw) {
        const problems = [];

        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return { ok: false, problems: ["That file does not look like a backup."], data: null };
        }

        const out = {
            characters: [],
            chats: {},
            chatHistory: {},
            lastActiveChats: {},
            chatMembers: {},
            settings: {},
            personalContext: {},
            apiKeys: {},
        };

        // Characters.
        if (Array.isArray(raw.characters)) {
            out.characters = raw.characters.filter((entry) => entry && typeof entry === "object");
            if (out.characters.length !== raw.characters.length) {
                problems.push("Some character entries were not readable and were skipped.");
            }
        } else if (raw.characters) {
            problems.push("The character list was not in the expected form, so it was skipped.");
        }

        // Chats. Only keep values that are arrays of messages.
        if (raw.chats && typeof raw.chats === "object" && !Array.isArray(raw.chats)) {
            Object.keys(raw.chats).forEach((chatId) => {
                const body = raw.chats[chatId];
                if (Array.isArray(body)) {
                    out.chats[chatId] = body.filter((m) => m && typeof m === "object");
                } else {
                    problems.push(`One chat (${chatId}) was not readable and was skipped.`);
                }
            });
        }

        // Chat history. Values must be arrays.
        if (raw.chatHistory && typeof raw.chatHistory === "object" && !Array.isArray(raw.chatHistory)) {
            Object.keys(raw.chatHistory).forEach((historyKey) => {
                const entries = raw.chatHistory[historyKey];
                if (Array.isArray(entries)) {
                    out.chatHistory[historyKey] = entries.filter((e) => e && typeof e === "object" && e.id);
                } else {
                    problems.push(`One history group (${historyKey}) was not readable and was skipped.`);
                }
            });
        }

        if (raw.lastActiveChats && typeof raw.lastActiveChats === "object" && !Array.isArray(raw.lastActiveChats)) {
            out.lastActiveChats = raw.lastActiveChats;
        }

        if (raw.chatMembers && typeof raw.chatMembers === "object" && !Array.isArray(raw.chatMembers)) {
            out.chatMembers = raw.chatMembers;
        }

        if (raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)) {
            out.settings = raw.settings;
        }

        if (raw.personalContext && typeof raw.personalContext === "object" && !Array.isArray(raw.personalContext)) {
            out.personalContext = raw.personalContext;
        }

        // Keys. Old files kept a single Gemini key under apiKey. Newer ones use a
        // map so several providers can be configured at once.
        if (typeof raw.apiKey === "string" && raw.apiKey) {
            out.apiKeys.gemini = raw.apiKey;
        }
        if (raw.apiKeys && typeof raw.apiKeys === "object" && !Array.isArray(raw.apiKeys)) {
            Object.keys(raw.apiKeys).forEach((providerId) => {
                if (typeof raw.apiKeys[providerId] === "string") {
                    out.apiKeys[providerId] = raw.apiKeys[providerId];
                }
            });
        }

        const hasSomething = out.characters.length > 0
            || Object.keys(out.chats).length > 0
            || Object.keys(out.settings).length > 0;

        if (!hasSomething) {
            return {
                ok: false,
                problems: problems.concat(["That file did not contain any characters or chats."]),
                data: null,
            };
        }

        return { ok: true, problems, data: out, summary: summarise(out) };
    }

    // Chat history in old files was filed under keys built by gluing a character
    // ID to a timestamp, because the code that saved it tried to recover
    // character IDs by splitting the chat ID on dashes and a timestamp survived
    // that test. The result was one group per chat rather than one per
    // character, and the character IDs recorded inside the entries included
    // timestamps that were never character IDs at all.
    //
    // This puts history back under the right character, using the chat records
    // themselves rather than trying to read meaning out of an ID string.
    function repairHistoryGrouping(chatHistory, characters) {
        const knownCharacterIds = new Set(
            (Array.isArray(characters) ? characters : [])
                .map((c) => (c && c.id ? String(c.id) : ""))
                .filter(Boolean)
        );

        const repaired = {};
        const chatMembers = {};
        let movedGroups = 0;
        let cleanedEntries = 0;

        const looksLikeTimestamp = (part) => /^\d{10,}$/.test(String(part));

        Object.keys(chatHistory || {}).forEach((historyKey) => {
            const entries = chatHistory[historyKey];
            if (!Array.isArray(entries)) return;

            entries.forEach((entry) => {
                if (!entry || !entry.id) return;

                // Work out the real character IDs for this entry. Prefer ones we
                // can confirm against the character list.
                const declared = Array.isArray(entry.characterIds) ? entry.characterIds.map(String) : [];
                let real = declared.filter((id) => knownCharacterIds.has(id));

                if (!real.length) {
                    // Fall back to reading the parts of the old key, keeping only
                    // pieces that are not timestamps.
                    real = String(historyKey)
                        .split("-")
                        .filter((part) => part && !looksLikeTimestamp(part))
                        .filter((part) => knownCharacterIds.size === 0 || knownCharacterIds.has(part));
                }

                if (!real.length) {
                    // Last resort, keep it where it was so nothing is lost.
                    real = String(historyKey).split("-").filter((p) => p && !looksLikeTimestamp(p));
                }

                const correctKey = real.join("-") || historyKey;
                if (correctKey !== historyKey) movedGroups += 1;

                const cleanedEntry = Object.assign({}, entry, { characterIds: real });
                if (declared.length !== real.length) cleanedEntries += 1;

                if (!repaired[correctKey]) repaired[correctKey] = [];
                // Do not add the same chat twice.
                if (!repaired[correctKey].some((e) => e.id === cleanedEntry.id)) {
                    repaired[correctKey].push(cleanedEntry);
                }

                chatMembers[entry.id] = real;
            });
        });

        // Newest first, which is how the history list reads best.
        Object.keys(repaired).forEach((key) => {
            repaired[key].sort((a, b) => {
                const at = Number(a.timestamp) || 0;
                const bt = Number(b.timestamp) || 0;
                return bt - at;
            });
        });

        return { chatHistory: repaired, chatMembers, movedGroups, cleanedEntries };
    }

    // Reminder timing.
    //
    // The rule is deliberately quiet. A reminder can appear when there is real
    // unsaved work and either a week has passed since the last backup or a good
    // amount of new activity has built up. Once dismissed it stays away for a
    // week. It never appears twice in one session, and never in the first few
    // minutes of using the app.
    const REMINDER = {
        minChangesSinceBackup: 25,
        daysSinceBackup: 7,
        snoozeDays: 7,
        minSessionMinutes: 5,
    };

    function shouldRemindAboutBackup(state, now) {
        const currentTime = now instanceof Date ? now.getTime() : Date.now();
        const safe = state || {};

        if (safe.remindedThisSession) return { remind: false, reason: "already-reminded" };

        const sessionMinutes = safe.sessionStartedAt
            ? (currentTime - new Date(safe.sessionStartedAt).getTime()) / 60000
            : 0;
        if (sessionMinutes < REMINDER.minSessionMinutes) {
            return { remind: false, reason: "too-early-in-session" };
        }

        if (safe.snoozedUntil && currentTime < new Date(safe.snoozedUntil).getTime()) {
            return { remind: false, reason: "snoozed" };
        }

        const changes = Number(safe.changesSinceBackup) || 0;
        if (changes < 1) return { remind: false, reason: "nothing-new" };

        const lastBackupTime = safe.lastBackupAt ? new Date(safe.lastBackupAt).getTime() : null;
        const daysSince = lastBackupTime === null
            ? Infinity
            : (currentTime - lastBackupTime) / 86400000;

        if (lastBackupTime === null && changes >= REMINDER.minChangesSinceBackup) {
            return {
                remind: true,
                reason: "never-backed-up",
                message: "You have built up a fair bit here and have not saved a backup yet. Worth doing now.",
            };
        }

        if (daysSince >= REMINDER.daysSinceBackup && changes >= 1) {
            const days = Math.floor(daysSince);
            return {
                remind: true,
                reason: "time-since-backup",
                message: `Your last backup was ${days} ${days === 1 ? "day" : "days"} ago and you have made changes since. A fresh one takes a second.`,
            };
        }

        if (changes >= REMINDER.minChangesSinceBackup) {
            return {
                remind: true,
                reason: "plenty-of-changes",
                message: "You have made a good number of changes since your last backup. Worth saving one.",
            };
        }

        return { remind: false, reason: "not-yet" };
    }

    function recordBackupTaken(state, now) {
        const when = now instanceof Date ? now : new Date();
        return Object.assign({}, state || {}, {
            lastBackupAt: when.toISOString(),
            changesSinceBackup: 0,
            snoozedUntil: null,
            remindedThisSession: false,
        });
    }

    function recordChange(state, count) {
        const safe = state || {};
        const step = Number.isFinite(count) ? count : 1;
        return Object.assign({}, safe, {
            changesSinceBackup: (Number(safe.changesSinceBackup) || 0) + step,
        });
    }

    function snoozeReminder(state, now) {
        const when = now instanceof Date ? now : new Date();
        const until = new Date(when.getTime() + REMINDER.snoozeDays * 86400000);
        return Object.assign({}, state || {}, {
            snoozedUntil: until.toISOString(),
            remindedThisSession: true,
        });
    }

    return {
        BACKUP_FORMAT,
        REMINDER,
        buildFilename,
        summarise,
        buildExport,
        normaliseImport,
        repairHistoryGrouping,
        shouldRemindAboutBackup,
        recordBackupTaken,
        recordChange,
        snoozeReminder,
    };
});
