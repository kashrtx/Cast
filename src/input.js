// What a keypress in the message box should do.
//
// This is a pure function so the behaviour can actually be tested, rather than
// being tangled up in an event handler where the only way to check it is to open a
// browser and try.
//
// The old handler said one thing and the placeholder said another. The code sent on
// Enter when there was text, but did nothing when the box was empty, so Enter
// inserted a newline in that one case. The placeholder meanwhile read "Enter for new
// line", which is the opposite of what everyone expects from a chat box.
//
// The rules now, stated once:
//
//   Enter               send
//   Shift with Enter    new line
//   Ctrl or Cmd Enter   new line, since some people reach for that instead
//   Enter, box empty    send anyway, which is how you ask a character to carry on
//   Enter mid response  nothing, because sending twice causes trouble
//
// The empty case matters. Sending nothing is a real feature in this app: it tells
// the character to continue on their own. Inserting a newline instead meant the one
// thing Enter did reliably was the thing nobody wanted.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastInput = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // Returns one of: "send", "newline", "ignore", "pass-through".
    //
    // "pass-through" means let the browser do whatever it normally would, which is
    // the right answer for every key that is not Enter.
    function decideKeyAction({ key, shiftKey, ctrlKey, metaKey, altKey, isComposing, value, responseInProgress }) {
        if (key !== "Enter") return "pass-through";

        // While text is being composed, for example when typing Japanese through an
        // input method, Enter confirms the characters being composed. Sending the
        // message there would cut someone off mid word.
        if (isComposing) return "pass-through";

        // Any of these means a deliberate request for a new line.
        if (shiftKey || ctrlKey || metaKey || altKey) return "newline";

        // Sending while a reply is already arriving causes duplicate responses, so
        // swallow it rather than queueing something up.
        if (responseInProgress) return "ignore";

        // Otherwise send, whether or not there is anything in the box. An empty send
        // asks the character to carry on by themselves.
        return "send";
    }

    // The placeholder text, kept here so the box and the behaviour can never drift
    // apart again. They used to disagree.
    const PLACEHOLDER = "Message... (Shift+Enter for a new line)";
    const PLACEHOLDER_WAITING = "Waiting for a reply...";
    const PLACEHOLDER_EMPTY_SENDS = "Message, or press Enter to let them continue";

    // Inserts a line break at the cursor and reports where the cursor should end up.
    // Separated out so it can be checked without a real textarea.
    function insertNewline(value, selectionStart, selectionEnd) {
        const text = typeof value === "string" ? value : "";
        const start = Number.isFinite(selectionStart) ? selectionStart : text.length;
        const end = Number.isFinite(selectionEnd) ? selectionEnd : start;

        return {
            value: `${text.slice(0, start)}\n${text.slice(end)}`,
            cursor: start + 1,
        };
    }

    return {
        decideKeyAction,
        insertNewline,
        PLACEHOLDER,
        PLACEHOLDER_WAITING,
        PLACEHOLDER_EMPTY_SENDS,
    };
});
