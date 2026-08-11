// ID generation.
//
// The old version was Math.random().toString(36).substring(2, 11). That looked
// fine but had two problems. About one in five thousand IDs came out shorter
// than nine characters, because a random value like 0.5 turns into the string
// "0.i" and the slice then has almost nothing to take. Short IDs matter here
// because parts of the app used to check whether one ID appeared inside another
// as plain text, so a one character ID could match almost anything.
//
// The other problem was that nothing checked for repeats.
//
// This version always returns a fixed length string, uses the browser's crypto
// source when it is available, and lets callers pass a set of IDs already in
// use so a repeat can never be handed out.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastIds = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
    const ID_LENGTH = 12;

    function randomBytes(count) {
        const cryptoObj = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
        if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
            return cryptoObj.getRandomValues(new Uint8Array(count));
        }

        // Fallback for very old browsers. Still fine for local IDs.
        const out = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) {
            out[i] = Math.floor(Math.random() * 256);
        }
        return out;
    }

    // Returns a lowercase alphanumeric string of exactly ID_LENGTH characters.
    function generateId() {
        const bytes = randomBytes(ID_LENGTH);
        let id = "";
        for (let i = 0; i < ID_LENGTH; i += 1) {
            id += ALPHABET[bytes[i] % ALPHABET.length];
        }
        return id;
    }

    // Same as generateId but guarantees the result is not already taken.
    // Pass anything with a has() method, such as a Set, or an array.
    function generateUniqueId(taken) {
        const has = (value) => {
            if (!taken) return false;
            if (typeof taken.has === "function") return taken.has(value);
            if (Array.isArray(taken)) return taken.indexOf(value) !== -1;
            if (typeof taken === "object") return Object.prototype.hasOwnProperty.call(taken, value);
            return false;
        };

        for (let attempt = 0; attempt < 50; attempt += 1) {
            const candidate = generateId();
            if (!has(candidate)) return candidate;
        }

        // Fifty collisions in a row is not realistically possible, but rather
        // than loop forever we fall back to something that cannot collide.
        return `${generateId()}${Date.now().toString(36)}`;
    }

    // Chat IDs used to be built by gluing character IDs together with dashes,
    // then a timestamp was appended for new chats. Code elsewhere tried to work
    // out which characters a chat belonged to by splitting that string back up,
    // which is what filed a lot of chat history under keys like
    // "abc123-1741404473116" instead of just "abc123".
    //
    // Chat IDs are now opaque. The link between a chat and its characters is
    // stored as real data on the chat record instead of being encoded in a
    // string and parsed back out later.
    function createChatId(taken) {
        return `chat_${generateUniqueId(taken)}`;
    }

    function isChatId(value) {
        return typeof value === "string" && value.indexOf("chat_") === 0;
    }

    return {
        ID_LENGTH,
        generateId,
        generateUniqueId,
        createChatId,
        isChatId,
    };
});
