// Tests for separating reasoning from replies.
//
// The split chunk tests are the important ones. They feed text one character at
// a time, which is the worst case a real stream can produce, and check that no
// part of a reasoning tag ever leaks into the visible reply.

const test = require("node:test");
const assert = require("node:assert");
const T = require("../src/thinking.js");

test("plain text passes through untouched", () => {
    const out = T.stripReasoningTags("She looked up and smiled.");
    assert.strictEqual(out.reply, "She looked up and smiled.");
    assert.strictEqual(out.reasoning, "");
});

test("a think block is removed and kept separately", () => {
    const out = T.stripReasoningTags("<think>The user wants warmth here.</think>Hey, you made it.");
    assert.strictEqual(out.reply, "Hey, you made it.");
    assert.strictEqual(out.reasoning, "The user wants warmth here.");
});

test("reasoning tag variants are all handled", () => {
    ["think", "thinking", "thought", "reasoning", "reflection"].forEach((tag) => {
        const out = T.stripReasoningTags(`<${tag}>hidden</${tag}>visible`);
        assert.strictEqual(out.reply, "visible", `tag ${tag} should be stripped`);
        assert.strictEqual(out.reasoning, "hidden");
    });
});

test("an unclosed reasoning block does not swallow the whole reply", () => {
    // This is what a response truncated mid reasoning looks like.
    const out = T.stripReasoningTags("<think>I should consider");
    assert.strictEqual(out.reply, "");
    assert.strictEqual(out.reasoning, "I should consider");
});

test("reasoning in the middle of a reply is removed", () => {
    const out = T.stripReasoningTags("Before. <think>middle</think> After.");
    assert.strictEqual(out.reply, "Before.  After.".trim());
    assert.strictEqual(out.reasoning, "middle");
});

test("a less than sign in ordinary dialogue is not treated as a tag", () => {
    const out = T.stripReasoningTags('She said "3 < 5" and laughed.');
    assert.strictEqual(out.reply, 'She said "3 < 5" and laughed.');
});

// --- Gemini response shape ---

test("Gemini thought parts are separated from reply parts", () => {
    const response = {
        candidates: [{
            finishReason: "STOP",
            content: {
                parts: [
                    { text: "Working out how she would answer. ", thought: true },
                    { text: "I did miss you, you know." },
                ],
            },
        }],
    };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "I did miss you, you know.");
    assert.strictEqual(out.reasoning, "Working out how she would answer.");
    assert.strictEqual(out.truncated, false);
});

test("Gemini text getter is ignored when real parts exist", () => {
    // Some SDK versions build .text by joining every part including thoughts.
    // If we trusted it we would show the reasoning, which was the original bug.
    const response = {
        text: "REASONING LEAKED HERE. The actual reply.",
        candidates: [{
            content: {
                parts: [
                    { text: "REASONING LEAKED HERE. ", thought: true },
                    { text: "The actual reply." },
                ],
            },
        }],
    };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "The actual reply.");
    assert.ok(!out.reply.includes("LEAKED"));
});

test("a Gemini response truncated by the token limit is flagged", () => {
    const response = {
        candidates: [{
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "thinking and thinking", thought: true }] },
        }],
    };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "");
    assert.strictEqual(out.truncated, true);
});

// --- OpenAI compatible shapes ---

test("OpenAI compatible reasoning_content is separated", () => {
    const response = {
        choices: [{
            finish_reason: "stop",
            message: { reasoning_content: "internal notes", content: "Out loud." },
        }],
    };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "Out loud.");
    assert.strictEqual(out.reasoning, "internal notes");
});

test("Ollama thinking field is separated", () => {
    const response = { message: { thinking: "hmm", content: "Right then." } };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "Right then.");
    assert.strictEqual(out.reasoning, "hmm");
});

test("Ollama inline think tags are also stripped", () => {
    const response = { message: { content: "<think>plan</think>Hello there." } };
    const out = T.extractFromResponse(response);
    assert.strictEqual(out.reply, "Hello there.");
    assert.strictEqual(out.reasoning, "plan");
});

test("an unrecognised response shape returns empty rather than throwing", () => {
    [null, undefined, 42, {}, { weird: true }, []].forEach((value) => {
        const out = T.extractFromResponse(value);
        assert.strictEqual(typeof out.reply, "string");
    });
});

// --- Streaming, including tags split across chunks ---

function streamAll(chunks) {
    const filter = T.createStreamFilter();
    let visible = "";
    chunks.forEach((chunk) => { visible += filter.consume(chunk); });
    const final = filter.finish();
    return { visible: visible + final.tail, final };
}

test("streaming plain text emits everything", () => {
    const { visible } = streamAll(["Hello ", "there, ", "friend."]);
    assert.strictEqual(visible, "Hello there, friend.");
});

test("streaming a whole think block emits nothing from it", () => {
    const { visible, final } = streamAll(["<think>secret</think>", "Visible."]);
    assert.strictEqual(visible, "Visible.");
    assert.strictEqual(final.reasoning, "secret");
});

test("a tag split across two chunks never leaks", () => {
    const { visible, final } = streamAll(["<thi", "nk>secret</thi", "nk>Visible."]);
    assert.strictEqual(visible, "Visible.");
    assert.ok(!visible.includes("<"), "no angle bracket should reach the reader");
    assert.strictEqual(final.reasoning, "secret");
});

test("one character at a time is still clean", () => {
    const source = "<think>never show this</think>Only this shows.";
    const { visible, final } = streamAll(source.split(""));
    assert.strictEqual(visible, "Only this shows.");
    assert.strictEqual(final.reasoning, "never show this");
});

test("one character at a time with reasoning at the end", () => {
    const source = "Reply first.<think>trailing thought</think>";
    const { visible } = streamAll(source.split(""));
    assert.strictEqual(visible, "Reply first.");
});

test("a stream that stops inside reasoning reports it", () => {
    const { visible, final } = streamAll(["<think>I was mid thought"]);
    assert.strictEqual(visible, "");
    assert.strictEqual(final.endedInsideReasoning, true);
});

test("nested reasoning tags are handled", () => {
    const { visible } = streamAll(["<think>outer<thinking>inner</thinking>still outer</think>Done."]);
    assert.strictEqual(visible, "Done.");
});

test("dialogue containing a less than sign survives streaming", () => {
    const { visible } = streamAll(['"x ', "< ", 'y" she said.']);
    assert.strictEqual(visible, '"x < y" she said.');
});

test("readChunk pulls reply and reasoning out of a streaming delta", () => {
    const out = T.readChunk({ choices: [{ delta: { content: "hi", reasoning: "think" } }] });
    assert.strictEqual(out.replyText, "hi");
    assert.strictEqual(out.reasoningText, "think");
});

// --- The guard that stops reasoning being saved as a reply ---

test("a real reply is accepted", () => {
    const v = T.verifyReply({ reply: "Hello.", reasoning: "some notes" });
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.reply, "Hello.");
});

test("reasoning with no reply is rejected", () => {
    const v = T.verifyReply({ reply: "", reasoning: "lots of notes" });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.problem, "reasoning-only");
});

test("running out of room mid reasoning gives actionable advice", () => {
    const v = T.verifyReply({ reply: "", reasoning: "notes", truncated: true });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.problem, "ran-out-of-room");
    assert.ok(v.message.includes("Settings"));
});

test("a completely empty response is rejected", () => {
    const v = T.verifyReply({ reply: "", reasoning: "" });
    assert.strictEqual(v.ok, false);
    assert.strictEqual(v.problem, "empty");
});

test("whitespace only is treated as empty, not as a reply", () => {
    const v = T.verifyReply({ reply: "   \n  ", reasoning: "" });
    assert.strictEqual(v.ok, false);
});
