// Safe loading and saving.
//
// What went wrong before
//
// The old loader read each key, and if the value would not parse it quietly
// returned an empty default. Then a cleanup routine walked the chat history,
// dropped every entry whose chat body it could not find, and wrote the result
// straight back. Put those two together and one unreadable value in the chats
// key caused the whole chat history to be deleted for good on the next reload.
//
// The cleanup also assumed every value in the history was an array. One value
// of the wrong type threw an error partway through loading. Nothing caught it,
// so the rest of the start up never ran and the app came up completely blank.
// The data was still there. It only looked deleted.
//
// The rules here
//
//   1. Nothing is ever deleted because it failed a check. Bad values are moved
//      aside into a quarantine key so they can be looked at later.
//   2. Loading never throws. A key that cannot be read gives a safe default and
//      records a problem for the caller to report.
//   3. A save that fails is reported to the caller. Every save is verified by
//      reading the value back, because some browsers accept a write past the
//      quota and then drop it.
//   4. A snapshot of good data is kept, so there is always something to restore.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastStorage = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const KEYS = {
        API_KEY: "gemini_api_key",
        CHARACTERS: "gemini_characters",
        CHATS: "gemini_chats",
        SETTINGS: "gemini_settings",
        PERSONAL_CONTEXT: "gemini_personal_context",
        CHAT_HISTORY: "gemini_chat_history",
        LAST_ACTIVE_CHATS: "gemini_last_active_chats",

        // Added by this version.
        QUARANTINE: "cast_quarantine",
        SNAPSHOT: "cast_snapshot",
        BACKUP_STATE: "cast_backup_state",
        CHAT_MEMBERS: "cast_chat_members",
        CHAT_MEMORY: "cast_chat_memory",
        ACTIVITY_LOG: "cast_activity_log",
        UI_STATE: "cast_ui_state",
    };

    // The original key names are kept exactly as they were. Renaming them would
    // have orphaned the data of anyone already using the app.

    const SHAPES = {
        [KEYS.API_KEY]: "string",
        [KEYS.CHARACTERS]: "array",
        [KEYS.CHATS]: "objectOfArrays",
        [KEYS.SETTINGS]: "object",
        [KEYS.PERSONAL_CONTEXT]: "object",
        [KEYS.CHAT_HISTORY]: "objectOfArrays",
        [KEYS.LAST_ACTIVE_CHATS]: "object",
        [KEYS.CHAT_MEMBERS]: "object",
        [KEYS.CHAT_MEMORY]: "object",
        [KEYS.ACTIVITY_LOG]: "array",
        [KEYS.UI_STATE]: "object",
    };

    const DEFAULTS = {
        string: () => "",
        array: () => [],
        object: () => ({}),
        objectOfArrays: () => ({}),
    };

    function isPlainObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    // Checks a loaded value against the shape we expect for that key.
    // Returns the value to use plus anything that had to be set aside.
    function coerceToShape(shape, value) {
        const fallback = (DEFAULTS[shape] || DEFAULTS.object)();

        if (value === null || value === undefined) {
            return { value: fallback, repaired: false, rejected: null };
        }

        if (shape === "string") {
            if (typeof value === "string") return { value, repaired: false, rejected: null };
            return { value: fallback, repaired: true, rejected: value };
        }

        if (shape === "array") {
            if (Array.isArray(value)) {
                // Drop entries that are not objects, but keep the rest.
                const good = value.filter(isPlainObject);
                const bad = value.filter((entry) => !isPlainObject(entry));
                return {
                    value: good,
                    repaired: bad.length > 0,
                    rejected: bad.length ? bad : null,
                };
            }
            return { value: fallback, repaired: true, rejected: value };
        }

        if (shape === "object") {
            if (isPlainObject(value)) return { value, repaired: false, rejected: null };
            return { value: fallback, repaired: true, rejected: value };
        }

        if (shape === "objectOfArrays") {
            if (!isPlainObject(value)) {
                return { value: fallback, repaired: true, rejected: value };
            }

            // This is the exact case that used to throw during start up and take
            // the whole app down with it. Now a value of the wrong type is moved
            // aside and the keys around it load normally.
            const good = {};
            const bad = {};
            Object.keys(value).forEach((key) => {
                const entry = value[key];
                if (Array.isArray(entry)) {
                    good[key] = entry;
                } else {
                    bad[key] = entry;
                }
            });

            return {
                value: good,
                repaired: Object.keys(bad).length > 0,
                rejected: Object.keys(bad).length ? bad : null,
            };
        }

        return { value, repaired: false, rejected: null };
    }

    // Wraps a storage backend. Pass one in for tests, or leave it out in the
    // browser and it uses localStorage.
    function createStore(backend) {
        const store = backend || (typeof localStorage !== "undefined" ? localStorage : null);

        function rawGet(key) {
            if (!store) return null;
            try {
                return store.getItem(key);
            } catch (error) {
                return null;
            }
        }

        function rawSet(key, text) {
            if (!store) return { ok: false, reason: "no-storage" };
            try {
                store.setItem(key, text);
            } catch (error) {
                const name = error && error.name ? error.name : "";
                const quota = name === "QuotaExceededError"
                    || name === "NS_ERROR_DOM_QUOTA_REACHED"
                    || /quota/i.test(String(error && error.message));
                return { ok: false, reason: quota ? "quota" : "write-failed", error };
            }

            // Some browsers accept the call and silently keep nothing, so read
            // it back rather than trusting that no error means success.
            try {
                if (store.getItem(key) !== text) {
                    return { ok: false, reason: "verify-failed" };
                }
            } catch (error) {
                return { ok: false, reason: "verify-failed", error };
            }

            return { ok: true };
        }

        function rawRemove(key) {
            if (!store) return;
            try {
                store.removeItem(key);
            } catch (error) {
                // Nothing useful to do here.
            }
        }

        // Moves a bad value into the quarantine key instead of dropping it.
        function quarantine(key, value, note) {
            const existingText = rawGet(KEYS.QUARANTINE);
            let existing = {};
            if (existingText) {
                try {
                    const parsed = JSON.parse(existingText);
                    if (isPlainObject(parsed)) existing = parsed;
                } catch (error) {
                    existing = {};
                }
            }

            existing[`${key}@${new Date().toISOString()}`] = {
                note: note || "",
                // Stored as text so a value that cannot be parsed is still kept.
                value: typeof value === "string" ? value.slice(0, 100000) : safeStringify(value),
            };

            const keptKeys = Object.keys(existing).slice(-10); // keep the last ten
            const trimmed = {};
            keptKeys.forEach((k) => { trimmed[k] = existing[k]; });

            rawSet(KEYS.QUARANTINE, safeStringify(trimmed) || "{}");
        }

        function safeStringify(value) {
            try {
                return JSON.stringify(value);
            } catch (error) {
                return null;
            }
        }

        // Reads one key. Never throws. Always returns something usable.
        function read(key, shape) {
            const expected = shape || SHAPES[key] || "object";
            const fallback = (DEFAULTS[expected] || DEFAULTS.object)();
            const text = rawGet(key);

            if (text === null || text === undefined) {
                return { value: fallback, problem: null, missing: true };
            }

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (error) {
                // Unreadable. Keep the raw text so nothing is lost, and hand the
                // caller a safe default plus a clear problem.
                quarantine(key, text, `could not be parsed: ${error.message}`);
                return {
                    value: fallback,
                    problem: {
                        key,
                        kind: "unreadable",
                        detail: error.message,
                        message: `Saved data under ${key} could not be read, so it was set aside rather than deleted.`,
                    },
                    missing: false,
                };
            }

            const checked = coerceToShape(expected, parsed);
            if (checked.repaired) {
                quarantine(key, checked.rejected, `unexpected shape for ${expected}`);
                return {
                    value: checked.value,
                    problem: {
                        key,
                        kind: "wrong-shape",
                        detail: `expected ${expected}`,
                        message: `Part of the data under ${key} was not in the expected form, so that part was set aside and the rest loaded normally.`,
                    },
                    missing: false,
                };
            }

            return { value: checked.value, problem: null, missing: false };
        }

        // Writes one key and tells you honestly whether it worked.
        function write(key, value) {
            const text = safeStringify(value);
            if (text === null) {
                return { ok: false, reason: "not-serialisable" };
            }
            return rawSet(key, text);
        }

        function remove(key) {
            rawRemove(key);
        }

        // Roughly how many characters the whole store is using. Browsers do not
        // expose the real quota, so this is for warnings, not accounting.
        function usage() {
            if (!store) return { characters: 0, keys: 0 };
            let characters = 0;
            let keys = 0;
            try {
                for (let i = 0; i < store.length; i += 1) {
                    const key = store.key(i);
                    if (key === null) continue;
                    const value = store.getItem(key) || "";
                    characters += key.length + value.length;
                    keys += 1;
                }
            } catch (error) {
                return { characters, keys };
            }
            return { characters, keys };
        }

        function getQuarantine() {
            const text = rawGet(KEYS.QUARANTINE);
            if (!text) return {};
            try {
                const parsed = JSON.parse(text);
                return isPlainObject(parsed) ? parsed : {};
            } catch (error) {
                return {};
            }
        }

        function clearQuarantine() {
            rawRemove(KEYS.QUARANTINE);
        }

        return {
            KEYS,
            read,
            write,
            remove,
            usage,
            quarantine,
            getQuarantine,
            clearQuarantine,
            rawGet,
            rawSet,
        };
    }

    // Loads everything the app needs in one go.
    //
    // The important promise here is that a problem with one key cannot affect
    // any other key, and cannot stop the app from starting.
    function loadAll(store) {
        const problems = [];
        const data = {};

        const plan = [
            [KEYS.API_KEY, "apiKey", "string"],
            [KEYS.CHARACTERS, "characters", "array"],
            [KEYS.CHATS, "chats", "objectOfArrays"],
            [KEYS.CHAT_HISTORY, "chatHistory", "objectOfArrays"],
            [KEYS.LAST_ACTIVE_CHATS, "lastActiveChats", "object"],
            [KEYS.SETTINGS, "settings", "object"],
            [KEYS.PERSONAL_CONTEXT, "personalContext", "object"],
            [KEYS.CHAT_MEMBERS, "chatMembers", "object"],
            [KEYS.CHAT_MEMORY, "chatMemory", "object"],
            [KEYS.ACTIVITY_LOG, "activityLog", "array"],
        ];

        plan.forEach(([key, name, shape]) => {
            let result;
            try {
                result = store.read(key, shape);
            } catch (error) {
                // read is written not to throw, but if it somehow does we still
                // must not stop loading the other keys.
                result = {
                    value: (DEFAULTS[shape] || DEFAULTS.object)(),
                    problem: {
                        key,
                        kind: "unexpected",
                        detail: error.message,
                        message: `Something went wrong reading ${key}. The rest of your data still loaded.`,
                    },
                };
            }
            data[name] = result.value;
            if (result.problem) problems.push(result.problem);
        });

        return { data, problems };
    }

    // Tidies up chat history without deleting anything.
    //
    // The old routine deleted history entries whose chat body was missing, and
    // saved that straight away. It is now read only. Entries whose body is
    // missing are reported as orphans and hidden from the list, but they stay in
    // storage in case the body comes back, for example after a failed import is
    // retried.
    function reviewChatHistory(chatHistory, chats) {
        const usable = {};
        const orphans = [];
        let malformed = 0;

        if (!isPlainObject(chatHistory)) {
            return { usable: {}, orphans: [], malformed: 0 };
        }

        Object.keys(chatHistory).forEach((historyKey) => {
            const entries = chatHistory[historyKey];
            if (!Array.isArray(entries)) {
                malformed += 1;
                return;
            }

            const keep = [];
            entries.forEach((entry) => {
                if (!isPlainObject(entry) || !entry.id) {
                    malformed += 1;
                    return;
                }
                const body = chats && chats[entry.id];
                if (Array.isArray(body)) {
                    keep.push(entry);
                } else {
                    orphans.push({ historyKey, id: entry.id });
                }
            });

            if (keep.length) usable[historyKey] = keep;
        });

        return { usable, orphans, malformed };
    }

    // Snapshots. A small copy of the text data, kept so there is always a known
    // good state to fall back on. Pictures are not included because they live
    // outside localStorage now.
    function saveSnapshot(store, data) {
        const snapshot = {
            savedAt: new Date().toISOString(),
            characters: data.characters,
            chats: data.chats,
            chatHistory: data.chatHistory,
            lastActiveChats: data.lastActiveChats,
            chatMembers: data.chatMembers,
        };
        return store.write(KEYS.SNAPSHOT, snapshot);
    }

    function readSnapshot(store) {
        const result = store.read(KEYS.SNAPSHOT, "object");
        const snapshot = result.value;
        if (!snapshot || !snapshot.savedAt) return null;
        return snapshot;
    }

    return {
        KEYS,
        SHAPES,
        createStore,
        coerceToShape,
        loadAll,
        reviewChatHistory,
        saveSnapshot,
        readSnapshot,
    };
});
