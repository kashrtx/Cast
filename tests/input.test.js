// Tests for what a keypress in the message box does.
//
// This existed only inside an event handler before, which meant the only way to check
// it was to open a browser and try. It is a plain function now, so the rules can be
// pinned down here.

const test = require("node:test");
const assert = require("node:assert");
const I = require("../src/input.js");

function press(overrides) {
    return I.decideKeyAction(Object.assign({
        key: "Enter",
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        isComposing: false,
        value: "hello",
        responseInProgress: false,
    }, overrides || {}));
}

test("Enter sends", () => {
    assert.strictEqual(press(), "send");
});

test("Shift with Enter makes a new line", () => {
    assert.strictEqual(press({ shiftKey: true }), "newline");
});

test("Ctrl or Cmd with Enter also makes a new line", () => {
    assert.strictEqual(press({ ctrlKey: true }), "newline");
    assert.strictEqual(press({ metaKey: true }), "newline");
    assert.strictEqual(press({ altKey: true }), "newline");
});

test("Enter on an empty box still sends", () => {
    // Sending nothing asks the character to carry on by themselves, which is a real
    // feature. This was the one case where Enter used to insert a newline instead,
    // which is the behaviour that was reported as annoying.
    assert.strictEqual(press({ value: "" }), "send");
    assert.strictEqual(press({ value: "   " }), "send");
});

test("Enter does nothing while a reply is still arriving", () => {
    // Sending twice produces duplicate responses.
    assert.strictEqual(press({ responseInProgress: true }), "ignore");
});

test("Shift with Enter still works while a reply is arriving", () => {
    // You should be able to keep drafting your next message.
    assert.strictEqual(press({ shiftKey: true, responseInProgress: true }), "newline");
});

test("Enter is left alone while an input method is composing", () => {
    // Typing Japanese or Chinese through an input method uses Enter to confirm the
    // characters being composed. Sending there would cut someone off mid word.
    assert.strictEqual(press({ isComposing: true }), "pass-through");
});

test("every other key is left alone", () => {
    ["a", "Backspace", "ArrowUp", "Tab", "Escape", " "].forEach((key) => {
        assert.strictEqual(press({ key }), "pass-through", `${key} should not be touched`);
    });
});

test("a new line goes in at the cursor, not at the end", () => {
    const result = I.insertNewline("hello world", 5, 5);
    assert.strictEqual(result.value, "hello\n world");
    assert.strictEqual(result.cursor, 6);
});

test("a new line replaces whatever was selected", () => {
    const result = I.insertNewline("hello world", 5, 11);
    assert.strictEqual(result.value, "hello\n");
});

test("a new line at the very start works", () => {
    assert.strictEqual(I.insertNewline("abc", 0, 0).value, "\nabc");
});

test("missing cursor information appends rather than throwing", () => {
    const result = I.insertNewline("abc");
    assert.strictEqual(result.value, "abc\n");
});

test("the placeholder tells you the right thing", () => {
    // It used to read "Enter for new line", which was the opposite of what the code
    // did and the opposite of what people expect.
    assert.ok(/shift/i.test(I.PLACEHOLDER), "it should mention Shift");
    assert.ok(!/^Type your message\.\.\. \(Enter for new line\)$/.test(I.PLACEHOLDER));
});
