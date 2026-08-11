// Tests for the log.
//
// The point of a log is being useful when something has gone wrong, so most of these are about
// failures being distinguishable from ordinary activity.

const test = require("node:test");
const assert = require("node:assert");
const L = require("../src/activitylog.js");

test("a failure is recorded as an error", () => {
    const entry = L.makeEntry(L.KINDS.REPLY_FAILED, "rate limited");
    assert.strictEqual(entry.level, "error");
    assert.strictEqual(L.isFailure(entry), true);
});

test("ordinary activity is not an error", () => {
    const entry = L.makeEntry(L.KINDS.CHARACTER_ADDED, "Rem");
    assert.strictEqual(entry.level, "info");
    assert.strictEqual(L.isFailure(entry), false);
});

test("data being set aside is a warning rather than a failure", () => {
    // Nothing was lost, so it should not read as alarming, but it is worth noticing.
    assert.strictEqual(L.levelOf(L.KINDS.DATA_SET_ASIDE), "warn");
});

test("every failure kind is marked as an error", () => {
    [L.KINDS.REPLY_FAILED, L.KINDS.SAVE_FAILED, L.KINDS.PROXY_FAILED,
     L.KINDS.STARTUP_FAILED, L.KINDS.UNCAUGHT_ERROR].forEach((kind) => {
        assert.strictEqual(L.levelOf(kind), "error", kind);
    });
});

test("an unknown kind is treated as ordinary rather than breaking", () => {
    assert.strictEqual(L.levelOf("something nobody predicted"), "info");
});

test("failures can be picked out of a busy log", () => {
    let log = [];
    log = L.append(log, L.KINDS.CHARACTER_ADDED, "Rem");
    log = L.append(log, L.KINDS.REPLY_FAILED, "rate limited");
    log = L.append(log, L.KINDS.CHAT_CLEARED, "8 messages");
    log = L.append(log, L.KINDS.SAVE_FAILED, "no room left");

    const failures = L.failuresOnly(log);
    assert.strictEqual(failures.length, 2);
    assert.ok(failures.every(L.isFailure));
});

test("a failure does not count as unsaved work", () => {
    // A reply failing has not changed anything, so it should not push you towards a backup.
    let log = [];
    log = L.append(log, L.KINDS.REPLY_FAILED, "rate limited");
    log = L.append(log, L.KINDS.UNCAUGHT_ERROR, "something broke");
    assert.strictEqual(L.countChangesSince(log, null), 0);

    log = L.append(log, L.KINDS.CHARACTER_ADDED, "Rem");
    assert.strictEqual(L.countChangesSince(log, null), 1);
});

test("the log can be turned into text for pasting", () => {
    let log = [];
    log = L.append(log, L.KINDS.CHARACTER_ADDED, "Rem");
    log = L.append(log, L.KINDS.REPLY_FAILED, "Gemini hit its free limit");

    const text = L.asText(log);
    assert.ok(text.includes("character added Rem"));
    assert.ok(text.includes("[error] reply failed"), text);
    // Newest first, so the most recent problem is at the top where it will be read.
    assert.ok(text.indexOf("reply failed") < text.indexOf("character added"));
});

test("an empty log says so rather than producing nothing", () => {
    assert.ok(L.asText([]).length > 0);
    assert.ok(L.asText(null).length > 0);
});

test("the summary names what has changed since a backup", () => {
    const earlier = new Date(Date.now() - 60000);
    let log = [L.makeEntry(L.KINDS.BACKUP_SAVED, "file.json", earlier)];
    log = L.append(log, L.KINDS.CHARACTER_ADDED, "Rem");
    log = L.append(log, L.KINDS.CHARACTER_ADDED, "Ram");

    const summary = L.summariseSince(log, earlier.toISOString());
    assert.ok(/2 character added/.test(summary), summary);
});

test("nothing having changed is said plainly", () => {
    const now = new Date().toISOString();
    assert.ok(/nothing has changed/i.test(L.summariseSince([], now)));
});

test("the log does not grow without limit", () => {
    let log = [];
    for (let i = 0; i < L.MAX_ENTRIES + 120; i += 1) {
        log = L.append(log, L.KINDS.CHARACTER_EDITED, `edit ${i}`);
    }
    assert.strictEqual(log.length, L.MAX_ENTRIES);
    // The newest are the ones kept.
    assert.ok(L.newestFirst(log)[0].detail.includes(String(L.MAX_ENTRIES + 119)));
});

test("timestamps are readable and to the second", () => {
    const formatted = L.formatTime(new Date(2026, 7, 10, 18, 42, 55).toISOString());
    assert.match(formatted, /10\/08\/2026 18:42:55/);
});

test("a broken timestamp does not break the line", () => {
    assert.strictEqual(typeof L.formatTime("not a date"), "string");
    assert.strictEqual(L.formatTime(""), "");
});
