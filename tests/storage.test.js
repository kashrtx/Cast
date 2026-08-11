// Tests for loading and saving.
//
// Several of these replay the exact situations that used to either blank the app
// or permanently delete chat history. They are the regression tests that matter
// most, so if one of them ever fails again, something has gone badly wrong.

const test = require("node:test");
const assert = require("node:assert");
const S = require("../src/storage.js");

// A stand in for localStorage that we can break on purpose.
function fakeBackend(initial) {
    const map = new Map(Object.entries(initial || {}));
    let failMode = null;

    return {
        get length() { return map.size; },
        key(i) { return Array.from(map.keys())[i] ?? null; },
        getItem(k) { return map.has(k) ? map.get(k) : null; },
        setItem(k, v) {
            if (failMode === "quota") {
                const error = new Error("exceeded the quota");
                error.name = "QuotaExceededError";
                throw error;
            }
            if (failMode === "silent") return; // accepts and keeps nothing
            map.set(k, String(v));
        },
        removeItem(k) { map.delete(k); },
        breakWith(mode) { failMode = mode; },
        repair() { failMode = null; },
        peek(k) { return map.get(k); },
        rawMap: map,
    };
}

const K = S.KEYS;

function healthyData() {
    return {
        [K.CHARACTERS]: JSON.stringify([{ id: "abc123abc123", name: "Saki" }]),
        [K.CHATS]: JSON.stringify({ chat_1: [{ id: "m1", content: "hi" }] }),
        [K.CHAT_HISTORY]: JSON.stringify({
            abc123abc123: [{ id: "chat_1", characterIds: ["abc123abc123"] }],
        }),
    };
}

test("healthy data loads with no problems reported", () => {
    const store = S.createStore(fakeBackend(healthyData()));
    const { data, problems } = S.loadAll(store);
    assert.strictEqual(problems.length, 0);
    assert.strictEqual(data.characters.length, 1);
    assert.strictEqual(Object.keys(data.chats).length, 1);
});

// --- The blank screen cases ---

test("a history key holding an object no longer stops loading", () => {
    // This threw a TypeError in the old code and the whole app came up blank.
    const raw = healthyData();
    const history = JSON.parse(raw[K.CHAT_HISTORY]);
    history.brokenKey = { id: "x", characterIds: ["y"] };
    raw[K.CHAT_HISTORY] = JSON.stringify(history);

    const store = S.createStore(fakeBackend(raw));
    const { data, problems } = S.loadAll(store);

    // Loading finished, the good key survived, the bad one was set aside.
    assert.ok(data.chatHistory.abc123abc123, "the good history key should still load");
    assert.strictEqual(data.chatHistory.brokenKey, undefined);
    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].kind, "wrong-shape");
    assert.strictEqual(data.characters.length, 1, "characters must be unaffected");
});

test("a history key holding null no longer stops loading", () => {
    const raw = healthyData();
    const history = JSON.parse(raw[K.CHAT_HISTORY]);
    history.nullKey = null;
    raw[K.CHAT_HISTORY] = JSON.stringify(history);

    const store = S.createStore(fakeBackend(raw));
    const { data, problems } = S.loadAll(store);
    assert.ok(data.chatHistory.abc123abc123);
    assert.strictEqual(problems.length, 1);
});

test("a problem with one key never affects another key", () => {
    const raw = healthyData();
    raw[K.CHATS] = "{ this is not json";
    const store = S.createStore(fakeBackend(raw));
    const { data, problems } = S.loadAll(store);

    assert.strictEqual(problems.length, 1);
    assert.strictEqual(problems[0].key, K.CHATS);
    // Characters and history loaded fine despite chats being broken.
    assert.strictEqual(data.characters.length, 1);
    assert.strictEqual(Object.keys(data.chatHistory).length, 1);
});

// --- The permanent deletion cases ---

test("unreadable data is set aside, never overwritten", () => {
    const backend = fakeBackend(healthyData());
    backend.rawMap.set(K.CHATS, "{ truncated");
    const store = S.createStore(backend);

    S.loadAll(store);

    // The original bytes must still be somewhere.
    const quarantined = store.getQuarantine();
    const keys = Object.keys(quarantined);
    assert.strictEqual(keys.length, 1);
    assert.ok(quarantined[keys[0]].value.includes("truncated"));
});

test("reviewing chat history never writes anything", () => {
    const backend = fakeBackend(healthyData());
    const store = S.createStore(backend);
    const before = backend.peek(K.CHAT_HISTORY);

    // Chats is empty, which used to cause every history entry to be deleted
    // and the empty result saved over the top.
    const review = S.reviewChatHistory(JSON.parse(before), {});

    assert.strictEqual(Object.keys(review.usable).length, 0);
    assert.strictEqual(review.orphans.length, 1);
    // The stored history is byte for byte unchanged.
    assert.strictEqual(backend.peek(K.CHAT_HISTORY), before);
});

test("history entries whose chat body is missing are reported, not removed", () => {
    const history = {
        charA: [{ id: "chat_present" }, { id: "chat_missing" }],
    };
    const chats = { chat_present: [] };
    const review = S.reviewChatHistory(history, chats);

    assert.strictEqual(review.usable.charA.length, 1);
    assert.strictEqual(review.orphans.length, 1);
    assert.strictEqual(review.orphans[0].id, "chat_missing");
});

// --- Save failures ---

test("a save that hits the quota is reported as failed", () => {
    const backend = fakeBackend({});
    const store = S.createStore(backend);
    backend.breakWith("quota");

    const result = store.write(K.CHATS, { a: [1] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "quota");
});

test("a save that is silently dropped is caught by reading it back", () => {
    // Some browsers accept the write, throw nothing, and keep nothing. The old
    // code would have believed the save succeeded.
    const backend = fakeBackend({});
    const store = S.createStore(backend);
    backend.breakWith("silent");

    const result = store.write(K.CHATS, { a: [1] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "verify-failed");
});

test("a successful save reports success", () => {
    const store = S.createStore(fakeBackend({}));
    const result = store.write(K.CHATS, { a: [1] });
    assert.strictEqual(result.ok, true);
});

test("a value that cannot be turned into json is reported", () => {
    const store = S.createStore(fakeBackend({}));
    const circular = {};
    circular.self = circular;
    const result = store.write(K.CHATS, circular);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "not-serialisable");
});

// --- Shape checking ---

test("an array key given an object falls back safely", () => {
    const out = S.coerceToShape("array", { not: "an array" });
    assert.deepStrictEqual(out.value, []);
    assert.strictEqual(out.repaired, true);
});

test("junk entries inside an array are dropped but good ones kept", () => {
    const out = S.coerceToShape("array", [{ id: 1 }, null, "nope", { id: 2 }]);
    assert.strictEqual(out.value.length, 2);
    assert.strictEqual(out.repaired, true);
});

test("missing keys give clean defaults with no problem reported", () => {
    const store = S.createStore(fakeBackend({}));
    const { data, problems } = S.loadAll(store);
    assert.strictEqual(problems.length, 0);
    assert.deepStrictEqual(data.characters, []);
    assert.deepStrictEqual(data.chats, {});
    assert.strictEqual(data.apiKey, "");
});

// --- Snapshots ---

test("a snapshot can be written and read back", () => {
    const store = S.createStore(fakeBackend({}));
    const data = {
        characters: [{ id: "a", name: "Test" }],
        chats: { chat_1: [] },
        chatHistory: {},
        lastActiveChats: {},
        chatMembers: {},
    };
    const wrote = S.saveSnapshot(store, data);
    assert.strictEqual(wrote.ok, true);

    const snapshot = S.readSnapshot(store);
    assert.ok(snapshot);
    assert.strictEqual(snapshot.characters[0].name, "Test");
    assert.ok(snapshot.savedAt);
});

test("reading a snapshot that was never written gives null", () => {
    const store = S.createStore(fakeBackend({}));
    assert.strictEqual(S.readSnapshot(store), null);
});

test("usage reports a character count", () => {
    const store = S.createStore(fakeBackend({ a: "12345" }));
    const usage = store.usage();
    assert.strictEqual(usage.keys, 1);
    assert.strictEqual(usage.characters, 6);
});
