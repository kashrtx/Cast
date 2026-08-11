// Tests for backups.
//
// The fixture is a real backup from June 2025, with the API key removed and the
// pictures shrunk. Everything else about it is untouched, including the badly
// grouped chat history, because that is what makes it a useful test.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const B = require("../src/backup.js");
const BRAND = require("../src/brand.js");

const FIXTURE = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixture-legacy-backup.json"), "utf8")
);

// --- Filenames ---

test("a filename says what it is, when, and how much is inside", () => {
    const name = B.buildFilename({
        slug: "cast",
        when: new Date(2026, 7, 9, 14, 32, 9),
        characterCount: 9,
        chatCount: 25,
        messageCount: 745,
    });
    assert.strictEqual(name, "cast-backup-2026-08-09-1432-09-9-chars-25-chats-745-messages.json");
});

test("two backups in the same minute do not collide", () => {
    const base = { slug: "cast", characterCount: 1, chatCount: 1, messageCount: 1 };
    const a = B.buildFilename(Object.assign({}, base, { when: new Date(2026, 7, 9, 14, 32, 9) }));
    const b = B.buildFilename(Object.assign({}, base, { when: new Date(2026, 7, 9, 14, 32, 44) }));
    assert.notStrictEqual(a, b);
});

test("filenames sort by name into date order", () => {
    const base = { slug: "cast", characterCount: 1, chatCount: 1, messageCount: 1 };
    const names = [
        B.buildFilename(Object.assign({}, base, { when: new Date(2026, 11, 1, 9, 0, 0) })),
        B.buildFilename(Object.assign({}, base, { when: new Date(2026, 0, 5, 9, 0, 0) })),
        B.buildFilename(Object.assign({}, base, { when: new Date(2026, 7, 9, 23, 59, 59) })),
    ];
    const sorted = names.slice().sort();
    assert.deepStrictEqual(sorted, [names[1], names[2], names[0]]);
});

test("a name with spaces or symbols is made filename safe", () => {
    const name = B.buildFilename({ slug: "My App! Name", when: new Date(2026, 0, 1), characterCount: 0, chatCount: 0, messageCount: 0 });
    assert.ok(!/[^a-z0-9\-.]/.test(name), `unexpected characters in ${name}`);
});

// --- Counting ---

test("counting the real backup gives the expected totals", () => {
    const counts = B.summarise(FIXTURE);
    assert.strictEqual(counts.characterCount, 9);
    assert.strictEqual(counts.chatCount, 25);
    assert.ok(counts.messageCount > 0);
});

// --- Loading old files ---

test("the real June 2025 backup loads", () => {
    const result = B.normaliseImport(FIXTURE);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.characters.length, 9);
    assert.strictEqual(Object.keys(result.data.chats).length, 25);
});

test("a single old apiKey field becomes a per provider key map", () => {
    const result = B.normaliseImport({
        characters: [{ id: "a", name: "x" }],
        chats: {},
        apiKey: "OLD-STYLE-KEY",
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.data.apiKeys.gemini, "OLD-STYLE-KEY");
});

test("a file with a broken chat still imports the rest", () => {
    const broken = JSON.parse(JSON.stringify(FIXTURE));
    const firstChatId = Object.keys(broken.chats)[0];
    broken.chats[firstChatId] = "this should be an array";

    const result = B.normaliseImport(broken);
    assert.strictEqual(result.ok, true);
    assert.ok(result.problems.length >= 1);
    assert.strictEqual(Object.keys(result.data.chats).length, 24);
    assert.strictEqual(result.data.characters.length, 9, "characters must be unaffected");
});

test("a file that is not a backup is refused clearly", () => {
    [null, undefined, 42, "text", [], {}].forEach((value) => {
        const result = B.normaliseImport(value);
        assert.strictEqual(result.ok, false);
        assert.ok(result.problems.length >= 1);
    });
});

test("an empty but well formed file is refused rather than wiping data", () => {
    const result = B.normaliseImport({ characters: [], chats: {} });
    assert.strictEqual(result.ok, false);
});

// --- Repairing the history grouping ---

test("the real backup has history filed under polluted keys", () => {
    // Confirms the fixture still demonstrates the bug, so the next test means
    // something.
    const polluted = Object.keys(FIXTURE.chatHistory).filter((key) => /-\d{10,}/.test(key));
    assert.ok(polluted.length > 0, "fixture should contain badly grouped history");
});

test("repairing regroups history under real characters only", () => {
    const result = B.repairHistoryGrouping(FIXTURE.chatHistory, FIXTURE.characters);
    const stillPolluted = Object.keys(result.chatHistory).filter((key) => /-\d{10,}/.test(key));
    assert.strictEqual(stillPolluted.length, 0, "no key should still contain a timestamp");
    assert.ok(result.movedGroups > 0, "some groups should have moved");
});

test("repairing loses no history entries", () => {
    const before = Object.values(FIXTURE.chatHistory)
        .filter(Array.isArray)
        .flat()
        .filter((e) => e && e.id);
    const uniqueBefore = new Set(before.map((e) => e.id));

    const result = B.repairHistoryGrouping(FIXTURE.chatHistory, FIXTURE.characters);
    const after = Object.values(result.chatHistory).flat();
    const uniqueAfter = new Set(after.map((e) => e.id));

    assert.strictEqual(uniqueAfter.size, uniqueBefore.size, "every chat must survive the repair");
});

test("repairing strips timestamps out of recorded character ids", () => {
    const result = B.repairHistoryGrouping(FIXTURE.chatHistory, FIXTURE.characters);
    const allIds = Object.values(result.chatHistory).flat().flatMap((e) => e.characterIds || []);
    const timestamps = allIds.filter((id) => /^\d{10,}$/.test(String(id)));
    assert.strictEqual(timestamps.length, 0);
});

test("repairing records which characters each chat belongs to", () => {
    const result = B.repairHistoryGrouping(FIXTURE.chatHistory, FIXTURE.characters);
    assert.ok(Object.keys(result.chatMembers).length > 0);
});

// --- Exporting ---

test("the key is left out of a backup by default", () => {
    const payload = B.buildExport({
        data: { characters: [], chats: {}, apiKeys: { gemini: "SECRET" } },
        brand: BRAND,
        includeApiKey: false,
    });
    assert.strictEqual(payload.apiKeys, undefined);
    assert.ok(!JSON.stringify(payload).includes("SECRET"));
});

test("the key is included only when explicitly asked for", () => {
    const payload = B.buildExport({
        data: { characters: [], chats: {}, apiKeys: { gemini: "SECRET" } },
        brand: BRAND,
        includeApiKey: true,
    });
    assert.strictEqual(payload.apiKeys.gemini, "SECRET");
});

test("an exported file states what is inside it", () => {
    const payload = B.buildExport({
        data: { characters: [{ id: "a" }], chats: { c1: [{}, {}] } },
        brand: BRAND,
        includeApiKey: false,
    });
    assert.strictEqual(payload.contents.characterCount, 1);
    assert.strictEqual(payload.contents.messageCount, 2);
    assert.strictEqual(payload.app, "Cast");
});

test("export then import returns the same characters and chats", () => {
    const original = {
        characters: FIXTURE.characters,
        chats: FIXTURE.chats,
        chatHistory: FIXTURE.chatHistory,
        lastActiveChats: FIXTURE.lastActiveChats,
        settings: FIXTURE.settings,
        personalContext: FIXTURE.personalContext,
    };

    const exported = B.buildExport({ data: original, brand: BRAND, includeApiKey: false });
    const roundTripped = B.normaliseImport(JSON.parse(JSON.stringify(exported)));

    assert.strictEqual(roundTripped.ok, true);
    assert.strictEqual(roundTripped.data.characters.length, original.characters.length);
    assert.strictEqual(
        Object.keys(roundTripped.data.chats).length,
        Object.keys(original.chats).length
    );

    let before = 0;
    Object.values(original.chats).forEach((m) => { before += m.length; });
    let after = 0;
    Object.values(roundTripped.data.chats).forEach((m) => { after += m.length; });
    assert.strictEqual(after, before, "no messages may be lost in a round trip");
});

test("a backup must carry picture data, not just a flag saying there is one", () => {
    // Version 2.0.0 wrote hasPicture true but no picture, because the export read
    // the character records and the pictures had been moved elsewhere. The file
    // looked complete and contained nothing. This checks the shape the exporter is
    // expected to produce.
    const withPictures = {
        characters: [
            { id: "a", name: "Has one", hasPicture: true, profilePicture: "data:image/png;base64,AAAA" },
            { id: "b", name: "Has none" },
        ],
        chats: {},
    };

    const payload = B.buildExport({ data: withPictures, brand: BRAND, includeApiKey: false });
    const claimed = payload.characters.filter(c => c.hasPicture).length;
    const carried = payload.characters.filter(c => c.profilePicture).length;

    assert.strictEqual(claimed, carried, "every character claiming a picture must carry its data");
    assert.strictEqual(carried, 1);
});

test("pictures survive a full export and reimport", () => {
    const original = {
        characters: [
            { id: "a", name: "Saki", hasPicture: true, profilePicture: "data:image/png;base64,AAAA" },
        ],
        chats: { chat_1: [{ id: "m1", content: "hi" }] },
    };

    const exported = B.buildExport({ data: original, brand: BRAND, includeApiKey: false });
    const back = B.normaliseImport(JSON.parse(JSON.stringify(exported)));

    assert.strictEqual(back.ok, true);
    assert.strictEqual(back.data.characters[0].profilePicture, "data:image/png;base64,AAAA");
});

test("a character flagged as having a picture but carrying none is detectable", () => {
    // This is the state a 2.0.0 file leaves behind. The app needs to be able to
    // spot it so it can fall back to showing an initial rather than nothing.
    const brokenFile = {
        characters: [{ id: "a", name: "Saki", hasPicture: true }],
        chats: {},
    };
    const back = B.normaliseImport(brokenFile);
    assert.strictEqual(back.ok, true);
    const character = back.data.characters[0];
    assert.strictEqual(character.hasPicture, true);
    assert.strictEqual(character.profilePicture, undefined, "the flag lies, and the app must cope");
});

// --- Reminders ---

const HOUR = 3600000;
const DAY = 86400000;

function stateFor(overrides) {
    const now = Date.now();
    return Object.assign({
        sessionStartedAt: new Date(now - HOUR).toISOString(),
        changesSinceBackup: 0,
        lastBackupAt: new Date(now - DAY).toISOString(),
        snoozedUntil: null,
        remindedThisSession: false,
    }, overrides || {});
}

test("no reminder in the first few minutes of a session", () => {
    const state = stateFor({
        sessionStartedAt: new Date().toISOString(),
        changesSinceBackup: 500,
        lastBackupAt: null,
    });
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, false);
});

test("no reminder when nothing has changed", () => {
    const state = stateFor({ changesSinceBackup: 0, lastBackupAt: new Date(Date.now() - 40 * DAY).toISOString() });
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, false);
});

test("a reminder after a week with changes", () => {
    const state = stateFor({
        changesSinceBackup: 5,
        lastBackupAt: new Date(Date.now() - 10 * DAY).toISOString(),
    });
    const result = B.shouldRemindAboutBackup(state);
    assert.strictEqual(result.remind, true);
    assert.strictEqual(result.reason, "time-since-backup");
});

test("a reminder after plenty of changes even if the backup is recent", () => {
    const state = stateFor({ changesSinceBackup: 40, lastBackupAt: new Date(Date.now() - HOUR).toISOString() });
    const result = B.shouldRemindAboutBackup(state);
    assert.strictEqual(result.remind, true);
    assert.strictEqual(result.reason, "plenty-of-changes");
});

test("a reminder when there has never been a backup and work has built up", () => {
    const state = stateFor({ changesSinceBackup: 30, lastBackupAt: null });
    const result = B.shouldRemindAboutBackup(state);
    assert.strictEqual(result.remind, true);
    assert.strictEqual(result.reason, "never-backed-up");
});

test("dismissing keeps it away for a week", () => {
    let state = stateFor({ changesSinceBackup: 100, lastBackupAt: null });
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, true);

    state = B.snoozeReminder(state);
    state.remindedThisSession = false; // pretend a fresh session
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, false);

    // Eight days later it may speak up again.
    const later = new Date(Date.now() + 8 * DAY);
    assert.strictEqual(B.shouldRemindAboutBackup(state, later).remind, true);
});

test("it never reminds twice in one session", () => {
    const state = stateFor({ changesSinceBackup: 100, lastBackupAt: null, remindedThisSession: true });
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, false);
});

test("taking a backup resets the counter", () => {
    let state = stateFor({ changesSinceBackup: 100, lastBackupAt: null });
    state = B.recordBackupTaken(state);
    assert.strictEqual(state.changesSinceBackup, 0);
    assert.ok(state.lastBackupAt);
    assert.strictEqual(B.shouldRemindAboutBackup(state).remind, false);
});

test("changes accumulate", () => {
    let state = stateFor({});
    state = B.recordChange(state);
    state = B.recordChange(state, 4);
    assert.strictEqual(state.changesSinceBackup, 5);
});
