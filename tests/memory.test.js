// Tests for conversation compaction.
//
// The most important ones are the group at the bottom. They check the promise this
// feature makes: it changes only what gets sent, never what is stored, and when
// anything goes wrong it falls back to sending everything rather than breaking the
// conversation.

const test = require("node:test");
const assert = require("node:assert");
const M = require("../src/memory.js");

function makeMessages(count, { charsEach = 200 } = {}) {
    const messages = [];
    for (let i = 0; i < count; i += 1) {
        messages.push({
            id: `m${i}`,
            content: `Message number ${i}. ${"x".repeat(Math.max(0, charsEach - 20))}`,
            isUser: i % 2 === 0,
            isDeleted: false,
        });
    }
    return messages;
}

// --- Measuring ---

test("an empty conversation measures as nothing", () => {
    assert.strictEqual(M.measureMessages([]).tokens, 0);
    assert.strictEqual(M.estimateTokens(""), 0);
    assert.strictEqual(M.estimateTokens(null), 0);
});

test("the token estimate leans high rather than low", () => {
    // Guessing low is what gets a request rejected for being too big, so the
    // estimate should never come out under the common four characters per token.
    const text = "x".repeat(400);
    assert.ok(M.estimateTokens(text) >= 100, "should not underestimate");
});

test("deleted, typing and system messages are not sent", () => {
    const messages = [
        { content: "real", isUser: true },
        { content: "gone", isDeleted: true },
        { content: "typing", isTyping: true },
        { content: "New conversation started.", isSystem: true },
        { content: "", isUser: true },
        { content: "   ", isUser: true },
    ];
    assert.strictEqual(M.sendableMessages(messages).length, 1);
});

// --- Deciding when to act ---

test("nothing happens when the setting is off", () => {
    const decision = M.shouldCompact({
        messages: makeMessages(500, { charsEach: 500 }),
        memory: {},
        enabled: false,
    });
    assert.strictEqual(decision.compact, false);
    assert.strictEqual(decision.reason, "turned-off");
});

test("a short conversation is left alone", () => {
    const decision = M.shouldCompact({
        messages: makeMessages(10),
        memory: {},
        enabled: true,
    });
    assert.strictEqual(decision.compact, false);
});

test("a long conversation is picked up", () => {
    const decision = M.shouldCompact({
        messages: makeMessages(200, { charsEach: 400 }),
        memory: {},
        enabled: true,
    });
    assert.strictEqual(decision.compact, true);
    assert.ok(decision.tokens > 16000);
});

test("a conversation that is long in messages but tiny in text is left alone", () => {
    // Fifty one word messages are not worth paying for a summary.
    const messages = makeMessages(50, { charsEach: 8 });
    const decision = M.shouldCompact({ messages, memory: {}, enabled: true });
    assert.strictEqual(decision.compact, false);
    assert.strictEqual(decision.reason, "still-small-enough");
});

test("it stops trying after repeated failures", () => {
    const decision = M.shouldCompact({
        messages: makeMessages(300, { charsEach: 500 }),
        memory: { consecutiveFailures: 3 },
        enabled: true,
    });
    assert.strictEqual(decision.compact, false);
    assert.strictEqual(decision.reason, "gave-up-after-failures");
});

test("a failure count resets on success", () => {
    let memory = { consecutiveFailures: 2 };
    memory = M.recordSuccess(memory, { summary: "x".repeat(200), coveredCount: 10, messageCount: 10 });
    assert.strictEqual(memory.consecutiveFailures, 0);
});

test("failures accumulate", () => {
    let memory = {};
    memory = M.recordFailure(memory, "network");
    memory = M.recordFailure(memory, "network");
    assert.strictEqual(memory.consecutiveFailures, 2);
    assert.strictEqual(memory.lastFailure.reason, "network");
});

// --- Choosing what to fold in ---

test("recent messages are kept word for word", () => {
    const messages = makeMessages(100, { charsEach: 400 });
    const plan = M.planCompaction({ messages, memory: {}, settings: { keepRecentMessages: 20 } });
    assert.strictEqual(plan.toKeep.length, 20);
    assert.strictEqual(plan.toSummarise.length, 80);
});

test("the newest message is always kept", () => {
    const messages = makeMessages(100, { charsEach: 400 });
    const plan = M.planCompaction({ messages, memory: {} });
    assert.strictEqual(plan.toKeep[plan.toKeep.length - 1].id, "m99");
});

test("nothing is summarised twice", () => {
    const messages = makeMessages(100, { charsEach: 400 });

    const first = M.planCompaction({ messages, memory: {}, settings: { keepRecentMessages: 20 } });
    assert.strictEqual(first.toSummarise.length, 80);
    assert.strictEqual(first.newCoveredCount, 80);

    // Twenty more messages arrive.
    const grown = messages.concat(makeMessages(20, { charsEach: 400 }).map((m, i) => ({
        ...m, id: `later${i}`,
    })));

    const second = M.planCompaction({
        messages: grown,
        memory: { summary: "notes", coveredCount: 80 },
        settings: { keepRecentMessages: 20 },
    });

    // Only the messages between the covered mark and the recent window.
    assert.strictEqual(second.toSummarise.length, 20);
    assert.strictEqual(second.toSummarise[0].id, "m80");
    assert.strictEqual(second.newCoveredCount, 100);
});

test("an earlier summary is carried into the next one", () => {
    const plan = M.planCompaction({
        messages: makeMessages(100),
        memory: { summary: "earlier notes", coveredCount: 40 },
    });
    assert.strictEqual(plan.previousSummary, "earlier notes");
});

// --- The prompt ---

test("the prompt asks for the headings that matter for a story", () => {
    const prompt = M.buildSummaryPrompt({
        characterName: "Saki",
        userName: "Alex",
        messages: makeMessages(4),
    });
    ["WHERE THINGS STAND", "WHAT IS TRUE", "BETWEEN THEM", "UNFINISHED", "RECENT EVENTS"].forEach((heading) => {
        assert.ok(prompt.includes(heading), `${heading} should be requested`);
    });
});

test("the prompt names both parties so the summary uses real names", () => {
    const prompt = M.buildSummaryPrompt({
        characterName: "Saki",
        userName: "Alex",
        messages: [{ content: "hello", isUser: true }],
    });
    assert.ok(prompt.includes("Saki"));
    assert.ok(prompt.includes("Alex"));
});

test("the prompt tells the model not to invent things", () => {
    const prompt = M.buildSummaryPrompt({ characterName: "x", messages: makeMessages(2) });
    assert.ok(/do not invent/i.test(prompt));
});

test("an earlier summary is included so nothing is dropped between rounds", () => {
    const prompt = M.buildSummaryPrompt({
        characterName: "Saki",
        previousSummary: "Alex has a sister called Mei.",
        messages: makeMessages(2),
    });
    assert.ok(prompt.includes("Mei"), "the old summary must be carried in");
});

// --- Checking a summary before trusting it ---

const goodSummary = `WHERE THINGS STAND: They are in the cafe on Sunday afternoon.
WHAT IS TRUE: Alex has a sister called Mei who lives in Osaka. Saki works nights.
BETWEEN THEM: Warmer than before, after Alex admitted he had been avoiding her.
UNFINISHED: Saki asked about his father and he changed the subject.
RECENT EVENTS: They argued, then made up over coffee.`;

test("a good summary is accepted", () => {
    const check = M.isUsableSummary(goodSummary);
    assert.strictEqual(check.ok, true);
});

test("a refusal is rejected", () => {
    const check = M.isUsableSummary("I'm sorry, I cannot help with summarising that conversation because it contains adult themes.");
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.reason, "refused");
});

test("something too short is rejected", () => {
    assert.strictEqual(M.isUsableSummary("They talked.").ok, false);
});

test("something in the wrong shape is rejected", () => {
    const rambling = "So basically these two people had a long chat about all sorts of things and it went on for a while and there was some tension but it worked out fine in the end I think, more or less.";
    const check = M.isUsableSummary(rambling);
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.reason, "wrong-shape");
});

test("a summary no smaller than what it replaced is rejected", () => {
    const tiny = makeMessages(3, { charsEach: 30 });
    const check = M.isUsableSummary(goodSummary + "x".repeat(2000), { foldedMessages: tiny });
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.reason, "not-smaller");
});

test("non text is rejected rather than stored", () => {
    [null, undefined, 42, {}, []].forEach((value) => {
        assert.strictEqual(M.isUsableSummary(value).ok, false);
    });
});

// --- The guarantees. These are the ones that matter. ---

test("with the setting off, everything is sent exactly as before", () => {
    const messages = makeMessages(300, { charsEach: 500 });
    const result = M.buildSendableHistory({ messages, memory: {}, enabled: false });

    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.summary, "");
    assert.strictEqual(result.messages.length, M.sendableMessages(messages).length);
});

test("with the setting on but no summary yet, everything is still sent", () => {
    const messages = makeMessages(300, { charsEach: 500 });
    const result = M.buildSendableHistory({ messages, memory: {}, enabled: true });
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.messages.length, 300);
});

test("compaction changes what is sent, never the stored messages", () => {
    const messages = makeMessages(100, { charsEach: 400 });
    const before = JSON.stringify(messages);

    const plan = M.planCompaction({ messages, memory: {} });
    const memory = M.recordSuccess({}, {
        summary: goodSummary,
        coveredCount: plan.newCoveredCount,
        messageCount: plan.toSummarise.length,
    });
    M.buildSendableHistory({ messages, memory, enabled: true });
    M.describeMemoryState(memory, messages);

    assert.strictEqual(JSON.stringify(messages), before, "the stored messages must be untouched");
});

test("turning the setting off after compacting restores the full conversation", () => {
    const messages = makeMessages(100, { charsEach: 400 });
    const memory = { summary: goodSummary, coveredCount: 80 };

    const on = M.buildSendableHistory({ messages, memory, enabled: true });
    assert.strictEqual(on.messages.length, 20);

    const off = M.buildSendableHistory({ messages, memory, enabled: false });
    assert.strictEqual(off.messages.length, 100, "every message comes back");
    assert.strictEqual(off.compacted, false);
});

test("deleting messages after a summary does not produce a broken fragment", () => {
    // The covered count now points past the end of the conversation. Sending a
    // fragment would be worse than sending everything, so it sends everything.
    const messages = makeMessages(10, { charsEach: 100 });
    const memory = { summary: goodSummary, coveredCount: 80 };

    const result = M.buildSendableHistory({ messages, memory, enabled: true });
    assert.strictEqual(result.compacted, false);
    assert.strictEqual(result.recovered, true);
    assert.strictEqual(result.messages.length, 10);
});

test("compacting actually reduces what is sent", () => {
    const messages = makeMessages(200, { charsEach: 400 });
    const full = M.buildSendableHistory({ messages, memory: {}, enabled: true });
    const compacted = M.buildSendableHistory({
        messages,
        memory: { summary: goodSummary, coveredCount: 180 },
        enabled: true,
    });
    assert.ok(compacted.estimatedTokens < full.estimatedTokens / 4,
        `expected a big reduction, got ${compacted.estimatedTokens} against ${full.estimatedTokens}`);
});

test("the summary is introduced as background the character already knows", () => {
    const text = M.formatSummaryForPrompt(goodSummary, "Saki");
    assert.ok(/already know/i.test(text));
    // It must not invite the character to talk about having notes.
    assert.ok(/do not mention/i.test(text));
});

test("no summary produces no preamble", () => {
    assert.strictEqual(M.formatSummaryForPrompt("", "Saki"), "");
});

test("the reader can be told plainly what is happening", () => {
    const messages = makeMessages(100, { charsEach: 400 });
    const off = M.describeMemoryState({}, messages);
    assert.strictEqual(off.compacted, false);
    assert.ok(/messages/.test(off.text));

    const on = M.describeMemoryState({ summary: goodSummary, coveredCount: 80 }, messages);
    assert.strictEqual(on.compacted, true);
    assert.ok(/summary/.test(on.text));
    assert.ok(/saving/.test(on.text));
});

test("settings that make no sense are brought back into range", () => {
    const settings = M.withSettings({ keepRecentMessages: -5, compactAboveTokens: 10 });
    assert.ok(settings.keepRecentMessages >= 4);
    assert.ok(settings.compactAboveTokens >= 2000);
});

test("a conversation of only deleted messages does not cause trouble", () => {
    const messages = [{ content: "gone", isDeleted: true }];
    const decision = M.shouldCompact({ messages, memory: {}, enabled: true });
    assert.strictEqual(decision.compact, false);
    const result = M.buildSendableHistory({ messages, memory: {}, enabled: true });
    assert.strictEqual(result.messages.length, 0);
});
