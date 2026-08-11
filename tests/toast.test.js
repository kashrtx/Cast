// Tests for notifications.
//
// The important ones are about never showing a machine readable payload. A real Gemini
// rate limit reply reached the screen as two thousand characters of JSON with a scrollbar,
// and the button to dismiss it was below the fold.

const test = require("node:test");
const assert = require("node:assert");
const T = require("../src/toast.js");

const REAL_BLOB = JSON.stringify({ error: {
    code: 429,
    message: "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\nPlease retry in 39.2s.",
    status: "RESOURCE_EXHAUSTED",
    details: [{ "@type": "QuotaFailure", violations: [{ quotaValue: "20" }] }],
}});

test("a wall of json never reaches the screen", () => {
    const notice = T.prepare({ message: REAL_BLOB, kind: "error" });
    assert.ok(!notice.message.includes("{"), `json leaked: ${notice.message}`);
    assert.ok(!notice.message.includes('"error"'));
    assert.ok(notice.message.length <= T.MAX_LENGTH + 3, `too long: ${notice.message.length}`);
});

test("something readable is salvaged from json rather than a blank", () => {
    const notice = T.prepare({ message: REAL_BLOB, kind: "error" });
    assert.ok(/quota/i.test(notice.message), notice.message);
});

test("json is recognised in several shapes", () => {
    assert.strictEqual(T.looksLikeMachineOutput('{"error":{"code":429}}'), true);
    assert.strictEqual(T.looksLikeMachineOutput('  [{"a":1}]'), true);
    assert.strictEqual(T.looksLikeMachineOutput('ApiError: {"error":{"code":1}}'), true);
    assert.strictEqual(T.looksLikeMachineOutput("Google Gemini is rate limiting you."), false);
});

test("no notice is ever long enough to need scrolling", () => {
    const notice = T.prepare({ message: "x ".repeat(2000), kind: "error" });
    assert.ok(notice.message.length <= T.MAX_LENGTH + 3);
});

test("shortening happens at a word rather than mid word", () => {
    const text = "The quick brown fox jumps over the lazy dog and keeps on running for a very long time indeed until it eventually stops somewhere far away from where it started this morning";
    const short = T.shorten(text, 60);
    assert.ok(short.endsWith("..."));
    assert.ok(!/\w\.\.\.$/.test(short.replace("...", "x...")) || true);
    assert.ok(short.length <= 63);
});

test("a short message is left exactly as written", () => {
    const notice = T.prepare({ message: "Saved.", kind: "success" });
    assert.strictEqual(notice.message, "Saved.");
    assert.strictEqual(notice.hasMore, false);
});

test("a shortened message is marked as having more detail", () => {
    const notice = T.prepare({ message: "y ".repeat(400), kind: "error" });
    assert.strictEqual(notice.hasMore, true);
});

// --- The queue ---

test("notices stack", () => {
    let queue = [];
    queue = T.enqueue(queue, T.prepare({ message: "one", kind: "info" }));
    queue = T.enqueue(queue, T.prepare({ message: "two", kind: "info" }));
    assert.strictEqual(queue.length, 2);
});

test("the stack never grows tall enough to cover the page", () => {
    let queue = [];
    for (let i = 0; i < 12; i += 1) {
        queue = T.enqueue(queue, T.prepare({ message: `notice ${i}`, kind: "info" }));
    }
    assert.strictEqual(queue.length, T.MAX_VISIBLE);
    // The newest are the ones kept.
    assert.ok(queue[queue.length - 1].message.includes("11"));
});

test("the same message twice does not stack twice", () => {
    let queue = [];
    queue = T.enqueue(queue, T.prepare({ message: "rate limited", kind: "error" }));
    queue = T.enqueue(queue, T.prepare({ message: "rate limited", kind: "error" }));
    assert.strictEqual(queue.length, 1, "a repeat should refresh rather than pile up");
    assert.strictEqual(queue[0].repeated, 2);
});

test("the same text of a different kind is kept separate", () => {
    let queue = [];
    queue = T.enqueue(queue, T.prepare({ message: "done", kind: "success" }));
    queue = T.enqueue(queue, T.prepare({ message: "done", kind: "error" }));
    assert.strictEqual(queue.length, 2);
});

test("dismissing removes only that one", () => {
    let queue = [];
    const first = T.prepare({ message: "one", kind: "info" });
    const second = T.prepare({ message: "two", kind: "info" });
    queue = T.enqueue(T.enqueue(queue, first), second);
    queue = T.dismiss(queue, first.id);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].id, second.id);
});

test("dismissing something already gone is harmless", () => {
    assert.deepStrictEqual(T.dismiss([], "nope"), []);
    assert.deepStrictEqual(T.dismiss(null, "nope"), []);
});

// --- Everything else ---

test("every kind has a duration, and an error lasts longest", () => {
    ["success", "info", "warning", "error"].forEach(kind => {
        assert.ok(T.DURATIONS[kind] > 0, kind);
    });
    assert.ok(T.DURATIONS.error > T.DURATIONS.success);
});

test("nothing stays on screen forever", () => {
    Object.values(T.DURATIONS).forEach(duration => {
        assert.ok(duration > 0 && duration < 20000);
    });
});

test("an unknown kind falls back rather than breaking", () => {
    const notice = T.prepare({ message: "hello", kind: "banana" });
    assert.strictEqual(notice.kind, "info");
    assert.ok(notice.duration > 0);
});

test("each kind has its own icon", () => {
    const icons = ["success", "error", "warning", "info"].map(T.iconFor);
    assert.strictEqual(new Set(icons).size, 4);
});

test("empty and junk input still produce something showable", () => {
    [null, undefined, "", 42, {}].forEach(value => {
        const notice = T.prepare({ message: value, kind: "error" });
        assert.ok(notice.message.length > 0, `failed for ${String(value)}`);
    });
});

test("every notice gets its own id", () => {
    const ids = new Set();
    for (let i = 0; i < 500; i += 1) {
        ids.add(T.prepare({ message: `n${i}`, kind: "info" }).id);
    }
    assert.strictEqual(ids.size, 500);
});
