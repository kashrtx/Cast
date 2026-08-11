// A record of what changed and when.
//
// Two reasons this exists. The line in Settings saying when you last backed up used to
// say "no changes since then" even after adding and deleting several characters,
// because nothing recomputed it. And more usefully, when something goes missing it is
// worth being able to look and see what actually happened rather than guessing.
//
// So every change that touches your data is written down here with a timestamp, and
// Settings shows it as a list you can open when you want it and ignore when you do not.
//
// It is deliberately small. A few hundred entries, plain text, no nesting. It is a log,
// not a history you can travel back through.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastLog = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // Enough to cover weeks of ordinary use without taking meaningful space.
    const MAX_ENTRIES = 300;

    // What kind of thing happened. Kept short, because these are shown as labels.
    const KINDS = {
        CHARACTER_ADDED: "character added",
        CHARACTER_EDITED: "character edited",
        CHARACTER_DELETED: "character deleted",
        CHARACTER_ENHANCED: "profile enhanced",
        CHAT_STARTED: "chat started",
        CHAT_CLEARED: "chat cleared",
        CHAT_DELETED: "chat deleted",
        GROUP_CREATED: "group created",
        GROUP_EDITED: "group edited",
        GROUP_DELETED: "group deleted",
        MESSAGE_DELETED: "message deleted",
        BACKUP_SAVED: "backup saved",
        BACKUP_LOADED: "backup loaded",
        SETTINGS_CHANGED: "settings changed",
        DATA_SET_ASIDE: "data set aside",
        SUMMARY_MADE: "conversation summarised",
    };

    // Which entries are worth counting as unsaved work, for the backup reminder.
    // Saving or loading a backup is not itself a change to your data.
    const NOT_A_CHANGE = new Set([KINDS.BACKUP_SAVED, KINDS.BACKUP_LOADED]);

    function makeEntry(kind, detail, when) {
        return {
            at: (when instanceof Date ? when : new Date()).toISOString(),
            kind: String(kind || "something happened"),
            detail: String(detail || ""),
        };
    }

    // Adds an entry and returns the new list. The oldest entries fall off the end.
    function append(entries, kind, detail, when) {
        const list = Array.isArray(entries) ? entries : [];
        const next = list.concat([makeEntry(kind, detail, when)]);
        return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
    }

    // Newest first, which is the order you want to read a log in.
    function newestFirst(entries) {
        return (Array.isArray(entries) ? entries : [])
            .slice()
            .sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }

    // Everything that happened after a given moment, used to show what has changed
    // since the last backup.
    function since(entries, isoTime) {
        if (!isoTime) return newestFirst(entries);
        return newestFirst(entries).filter((entry) => String(entry.at) > String(isoTime));
    }

    // How many of those count as unsaved work.
    function countChangesSince(entries, isoTime) {
        return since(entries, isoTime).filter((entry) => !NOT_A_CHANGE.has(entry.kind)).length;
    }

    // A short summary for the line above the log.
    function summariseSince(entries, isoTime) {
        const relevant = since(entries, isoTime).filter((entry) => !NOT_A_CHANGE.has(entry.kind));
        if (!relevant.length) return "Nothing has changed since then.";

        // Group by kind so it reads as a summary rather than a list.
        const counts = {};
        relevant.forEach((entry) => {
            counts[entry.kind] = (counts[entry.kind] || 0) + 1;
        });

        const parts = Object.keys(counts)
            .sort((a, b) => counts[b] - counts[a])
            .slice(0, 3)
            .map((kind) => (counts[kind] > 1 ? `${counts[kind]} ${kind}` : `1 ${kind}`));

        const extra = Object.keys(counts).length > 3 ? ", and more" : "";
        return `Since then: ${parts.join(", ")}${extra}.`;
    }

    // Formats a timestamp for reading. Local time, to the second, because the point of
    // a log is being able to line it up with when you remember doing something.
    function formatTime(isoTime) {
        const date = new Date(isoTime);
        if (Number.isNaN(date.getTime())) return String(isoTime || "");

        const pad = (value) => String(value).padStart(2, "0");
        const day = `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
        const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
        return `${day} ${clock}`;
    }

    return {
        MAX_ENTRIES,
        KINDS,
        NOT_A_CHANGE,
        makeEntry,
        append,
        newestFirst,
        since,
        countChangesSince,
        summariseSince,
        formatTime,
    };
});
