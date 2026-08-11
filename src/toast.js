// Notifications.
//
// What was wrong with the old one
//
// There was a single banner that sat in the page. It grew to whatever size the message
// needed, so a provider error of two thousand characters of JSON filled the screen, gained
// a scrollbar, and pushed the message box off the bottom. To dismiss it you had to scroll
// inside it to find the button. It read like an advert rather than a notification.
//
// What this does instead
//
// Short notices that appear over the page, stack, and take themselves away. Nothing is
// ever tall enough to need scrolling, because the text is shortened before it is shown and
// the long version goes to the log. Tapping one dismisses it.
//
// The queue logic lives here so it can be tested. Anything to do with the page itself is
// in the app.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastToast = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // How long each kind stays. An error stays longest, because it usually asks something
    // of you. Nothing stays forever.
    const DURATIONS = {
        success: 3200,
        info: 4000,
        warning: 6000,
        error: 8000,
    };

    // Beyond this many at once, the oldest goes to make room. A stack taller than this
    // covers the thing you were looking at.
    const MAX_VISIBLE = 3;

    // Longer than this and it stops being a notification. The full text goes to the log.
    const MAX_LENGTH = 190;

    // Trims to a whole word rather than mid word, which reads as broken.
    function shorten(text, limit) {
        const value = String(text === null || text === undefined ? "" : text).replace(/\s+/g, " ").trim();
        const cap = limit || MAX_LENGTH;
        if (value.length <= cap) return value;

        const cut = value.slice(0, cap);
        const lastSpace = cut.lastIndexOf(" ");
        const trimmed = lastSpace > cap * 0.6 ? cut.slice(0, lastSpace) : cut;
        return `${trimmed.replace(/[,.;:]$/, "")}...`;
    }

    // Anything that looks like a machine readable payload must never be shown as is.
    //
    // This is the guard that stops a wall of JSON reaching the screen. Several places pass
    // a raw error straight through, and rather than trusting every one of them to remember,
    // it is caught here.
    function looksLikeMachineOutput(text) {
        const value = String(text || "");
        if (!value) return false;
        if (value.trim().startsWith("{") || value.trim().startsWith("[")) return true;
        // A stray quote followed by a colon is a good sign of json in the middle of a string.
        if (/"\s*:\s*[{["]/.test(value)) return true;
        if (value.includes('{"error"')) return true;
        return false;
    }

    // Pulls something readable out of a payload, when one slips through.
    function salvage(text) {
        const value = String(text || "");
        const firstBrace = value.indexOf("{");
        if (firstBrace !== -1) {
            try {
                const parsed = JSON.parse(value.slice(firstBrace));
                const body = parsed && parsed.error ? parsed.error : parsed;
                if (body && body.message) return String(body.message).split("\n")[0];
                if (body && body.status) return String(body.status);
            } catch (error) {
                // Falls through to the text handling below.
            }
        }
        // Not parseable, so take the first sentence that is not obviously structure.
        const firstLine = value.split("\n").find(line => line.trim() && !/^[{\["]/.test(line.trim()));
        return firstLine ? firstLine.trim() : "Something went wrong.";
    }

    // Prepares a notice for showing. Always returns something short and readable.
    function prepare({ message, kind, title }) {
        const type = DURATIONS[kind] ? kind : "info";
        let text = String(message === null || message === undefined ? "" : message);

        let hadDetail = false;
        if (looksLikeMachineOutput(text)) {
            text = salvage(text);
            hadDetail = true;
        }

        const shortened = shorten(text);
        if (shortened.length < text.replace(/\s+/g, " ").trim().length) hadDetail = true;

        return {
            id: `toast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            kind: type,
            title: title || defaultTitle(type),
            message: shortened || "Something went wrong.",
            duration: DURATIONS[type],
            hasMore: hadDetail,
            at: new Date().toISOString(),
        };
    }

    function defaultTitle(kind) {
        switch (kind) {
            case "success": return "Done";
            case "error": return "Something went wrong";
            case "warning": return "Careful";
            default: return "";
        }
    }

    // Adds to the queue, dropping the oldest when it is full.
    function enqueue(queue, notice) {
        const list = Array.isArray(queue) ? queue.slice() : [];

        // The same message twice in a row is noise. Refresh the existing one instead.
        const duplicate = list.find(entry => entry.message === notice.message && entry.kind === notice.kind);
        if (duplicate) {
            duplicate.at = notice.at;
            duplicate.repeated = (duplicate.repeated || 1) + 1;
            return list;
        }

        list.push(notice);
        return list.length > MAX_VISIBLE ? list.slice(list.length - MAX_VISIBLE) : list;
    }

    function dismiss(queue, id) {
        return (Array.isArray(queue) ? queue : []).filter(entry => entry.id !== id);
    }

    // Which icon suits which kind.
    function iconFor(kind) {
        switch (kind) {
            case "success": return "fa-circle-check";
            case "error": return "fa-circle-exclamation";
            case "warning": return "fa-triangle-exclamation";
            default: return "fa-circle-info";
        }
    }

    return {
        DURATIONS,
        MAX_VISIBLE,
        MAX_LENGTH,
        shorten,
        looksLikeMachineOutput,
        salvage,
        prepare,
        enqueue,
        dismiss,
        iconFor,
        defaultTitle,
    };
});
