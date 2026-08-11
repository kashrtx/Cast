// Escaping text before it goes into HTML.
//
// Character names were being dropped straight into innerHTML in the character
// lists and the chat header. A character named with a bit of HTML in it would
// run as markup rather than showing as text.
//
// On its own that is only something you could do to yourself, which is not much
// of a problem. It matters because this app can import a backup file. Opening a
// file from someone else meant running whatever they had put in a character
// name, on your page, where your API key is kept. So it is worth closing.
//
// Chat messages were already safe, since they go through DOMPurify.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastEscape = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const HTML_ENTITIES = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    };

    // For text that goes between tags, and for quoted attribute values.
    function escapeHtml(value) {
        if (value === null || value === undefined) return "";
        return String(value).replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);
    }

    // For a value going into an attribute. Same rules, kept as its own function
    // so the intent is obvious at the call site.
    function escapeAttribute(value) {
        return escapeHtml(value);
    }

    // For a URL going into src or href.
    //
    // Escaping alone is not enough for URLs, because javascript: is dangerous
    // without containing any character that escaping would touch. Only data URLs
    // for images and ordinary web and local addresses are allowed through.
    function safeImageUrl(value) {
        if (typeof value !== "string") return "";
        const trimmed = value.trim();

        if (/^data:image\/(png|jpe?g|gif|webp|avif);base64,/i.test(trimmed)) {
            return escapeAttribute(trimmed);
        }
        if (/^https?:\/\//i.test(trimmed)) {
            return escapeAttribute(trimmed);
        }
        if (/^blob:/i.test(trimmed)) {
            return escapeAttribute(trimmed);
        }
        // Plain relative paths, with no scheme and no protocol trickery.
        if (/^[a-z0-9._\-/]+$/i.test(trimmed)) {
            return escapeAttribute(trimmed);
        }

        return "";
    }

    // The first letter of a name, for the fallback avatar circle.
    function initial(name) {
        const text = typeof name === "string" ? name.trim() : "";
        if (!text) return "?";
        return escapeHtml(text.charAt(0).toUpperCase());
    }

    return {
        escapeHtml,
        escapeAttribute,
        safeImageUrl,
        initial,
    };
});
