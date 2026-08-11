// Keeping long conversations affordable without losing the thread.
//
// The problem
//
// Models have no memory. Every turn resends the whole conversation, so the cost
// of turn 200 includes turns 1 to 199. That makes the total cost of a chat grow
// with the square of its length. Measured on a real 219 message chat from this
// app, the last turn alone sent about 15,600 tokens, and the chat as a whole had
// sent roughly 1.7 million. Long chats get slower, more expensive, and eventually
// hit the model's limit.
//
// What this does
//
// Once a conversation passes a size threshold, the older part is replaced, for
// sending purposes only, with a written summary. Recent messages are still sent
// word for word, because that is what keeps the immediate scene coherent.
//
// The one rule that matters
//
// This never changes your stored messages. Not one is edited, moved or deleted.
// The summary is kept alongside the chat, and only the version sent to the model
// is shortened. Turn the setting off and the very next message is sent exactly as
// it would have been before this file existed.
//
// That is a deliberate difference from how coding assistants do it. They throw the
// raw history away, because for them it is working scratch. Here the messages are
// the whole point of the app, so they stay.
//
// If anything goes wrong, summarising is abandoned and the full conversation is
// sent instead. Failing means paying more, never breaking the chat.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastMemory = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const DEFAULTS = {
        // Roughly how many tokens of conversation before it is worth summarising.
        // Not driven by the model's limit, because the limits are now large while
        // the cost and the wait are felt long before you reach them.
        compactAboveTokens: 16000,

        // How many recent messages are always sent word for word. The scene right
        // now needs exact wording. Anything older is served well enough by a good
        // summary.
        keepRecentMessages: 20,

        // Never summarise unless there is a decent block to work on, otherwise you
        // pay for a summarising call that saves almost nothing.
        minMessagesToSummarise: 12,

        // Room left for the reply, so summarising can never squeeze out the answer.
        outputHeadroomTokens: 4096,

        // Give up after this many failures in a row and just send everything.
        maxConsecutiveFailures: 3,
    };

    // Characters per token. Four is the usual rule of thumb for English. Three and
    // a half is used here so the estimate leans high, since guessing low is what
    // causes a request to be rejected for being too large.
    const CHARS_PER_TOKEN = 3.5;

    function estimateTokens(text) {
        if (typeof text !== "string" || !text) return 0;
        return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    // Rough size of a list of messages, including a little for the role labels and
    // structure that wrap each one.
    function measureMessages(messages) {
        const list = Array.isArray(messages) ? messages : [];
        let tokens = 0;
        let counted = 0;

        list.forEach((message) => {
            if (!message || typeof message !== "object") return;
            const content = typeof message.content === "string" ? message.content : "";
            tokens += estimateTokens(content) + 4; // 4 for the wrapper
            counted += 1;
        });

        return { tokens, messages: counted };
    }

    // Messages worth sending to the model. Deleted ones, typing indicators and the
    // app's own notices are not part of the story.
    function isSendable(message) {
        if (!message || typeof message !== "object") return false;
        if (message.isDeleted) return false;
        if (message.isTyping) return false;
        if (message.isSystem) return false;
        if (message.isContinue) return false;
        // A note about the character being unavailable is not part of the story, so it is
        // neither sent nor summarised.
        if (message.isError) return false;
        const content = typeof message.content === "string" ? message.content : "";
        return content.trim().length > 0;
    }

    function sendableMessages(messages) {
        return (Array.isArray(messages) ? messages : []).filter(isSendable);
    }

    function withSettings(settings) {
        const merged = Object.assign({}, DEFAULTS, settings || {});
        // Guard against values that would behave strangely.
        merged.keepRecentMessages = Math.max(4, Math.min(200, parseInt(merged.keepRecentMessages, 10) || DEFAULTS.keepRecentMessages));
        merged.compactAboveTokens = Math.max(2000, parseInt(merged.compactAboveTokens, 10) || DEFAULTS.compactAboveTokens);
        merged.minMessagesToSummarise = Math.max(2, parseInt(merged.minMessagesToSummarise, 10) || DEFAULTS.minMessagesToSummarise);
        return merged;
    }

    // Decides whether it is worth summarising right now.
    //
    // Returns a decision object rather than a bare true or false, so the caller can
    // explain itself and so this is straightforward to test.
    function shouldCompact({ messages, memory, settings, enabled }) {
        const config = withSettings(settings);
        const state = memory || {};

        if (!enabled) {
            return { compact: false, reason: "turned-off" };
        }

        if (state.consecutiveFailures >= config.maxConsecutiveFailures) {
            return { compact: false, reason: "gave-up-after-failures" };
        }

        const usable = sendableMessages(messages);

        // Only the part that is not already summarised counts towards the decision.
        const alreadyCovered = Number(state.coveredCount) || 0;
        const uncovered = usable.slice(alreadyCovered);
        const candidates = uncovered.slice(0, Math.max(0, uncovered.length - config.keepRecentMessages));

        if (candidates.length < config.minMessagesToSummarise) {
            return { compact: false, reason: "not-enough-to-summarise", candidateCount: candidates.length };
        }

        // Measure what would actually be sent if we did nothing.
        const wouldSend = measureMessages(uncovered).tokens + estimateTokens(state.summary || "");
        if (wouldSend < config.compactAboveTokens) {
            return { compact: false, reason: "still-small-enough", tokens: wouldSend };
        }

        return {
            compact: true,
            reason: "large-enough",
            tokens: wouldSend,
            candidateCount: candidates.length,
        };
    }

    // Works out exactly which messages get summarised and which are sent as they
    // are. Kept separate from the decision so both can be checked on their own.
    function planCompaction({ messages, memory, settings }) {
        const config = withSettings(settings);
        const state = memory || {};
        const usable = sendableMessages(messages);

        const alreadyCovered = Number(state.coveredCount) || 0;
        const uncovered = usable.slice(alreadyCovered);
        const summariseCount = Math.max(0, uncovered.length - config.keepRecentMessages);

        return {
            // Messages to fold into the summary this time.
            toSummarise: uncovered.slice(0, summariseCount),
            // Messages that stay word for word.
            toKeep: uncovered.slice(summariseCount),
            // How many of the sendable messages will be covered by the summary once
            // this is done. Stored so the next round knows where to carry on.
            newCoveredCount: alreadyCovered + summariseCount,
            previousSummary: state.summary || "",
        };
    }

    // The summary contract.
    //
    // A vague instruction produces a vague summary, and a vague summary is what
    // makes a character forget your name or repeat a scene. So this asks for
    // specific headings and specifically asks for names and details to be kept.
    //
    // The headings are chosen for roleplay rather than for code. What matters here
    // is who these people are to each other, what has been established as true,
    // and what is unfinished.
    function buildSummaryPrompt({ characterName, userName, previousSummary, messages }) {
        const who = userName || "the user";
        const lines = (Array.isArray(messages) ? messages : []).map((message) => {
            const speaker = message.isUser ? who : (characterName || "Character");
            return `${speaker}: ${message.content}`;
        }).join("\n");

        const carryOver = previousSummary
            ? `Here is the summary of everything before this point. Fold the new material into it and return one combined summary, keeping anything from it that still matters:\n\n${previousSummary}\n\n`
            : "";

        return `You are helping keep track of a long roleplay conversation between ${characterName || "a character"} and ${who}.

${carryOver}Here is the part of the conversation to summarise:

${lines}

Write a summary that another writer could use to carry on this story without having read any of the above. Use exactly these headings, and leave a heading out only if there is genuinely nothing to put under it.

WHERE THINGS STAND: the setting, the time, and where the characters physically are.

WHAT IS TRUE: facts established during the conversation. Names, ages, jobs, family, history, promises, anything either person revealed about themselves. Keep the exact names and details. This is the part that must not be lost.

BETWEEN THEM: how these two are with each other now, and how that changed over this stretch. Be specific about what caused the change.

UNFINISHED: questions asked and not answered, plans made and not carried out, tension not resolved, anything the story is still owed.

RECENT EVENTS: what happened, briefly, in the order it happened.

Rules:
- Write plainly. This is notes for a writer, not prose.
- Keep specific details over general impressions. "She said her sister Mei lives in Osaka" is useful. "They discussed family" is not.
- Do not invent anything that is not in the text above.
- Do not write in character and do not address anyone. Just the notes.`;
    }

    // Builds what actually gets sent.
    //
    // With no summary this returns every sendable message, which is the same thing
    // the app sent before any of this existed. That is the point. The feature off,
    // or on but not yet triggered, means unchanged behaviour.
    function buildSendableHistory({ messages, memory, settings, enabled }) {
        const config = withSettings(settings);
        const state = memory || {};
        const usable = sendableMessages(messages);

        if (!enabled || !state.summary) {
            return {
                summary: "",
                messages: usable,
                compacted: false,
                estimatedTokens: measureMessages(usable).tokens,
            };
        }

        const covered = Number(state.coveredCount) || 0;

        // If the covered count is somehow beyond the messages we have, for example
        // because messages were deleted after a summary was made, fall back to
        // sending everything rather than sending a confusing fragment.
        if (covered > usable.length) {
            return {
                summary: "",
                messages: usable,
                compacted: false,
                recovered: true,
                estimatedTokens: measureMessages(usable).tokens,
            };
        }

        const verbatim = usable.slice(covered);

        return {
            summary: state.summary,
            messages: verbatim,
            compacted: true,
            coveredCount: covered,
            estimatedTokens: measureMessages(verbatim).tokens + estimateTokens(state.summary),
        };
    }

    // How the summary is introduced to the model. Phrased so the model treats it as
    // background it already knows, not as something a person just said to it.
    function formatSummaryForPrompt(summary, characterName) {
        if (!summary) return "";
        return `WHAT HAS HAPPENED SO FAR:
The conversation below carries on from an earlier stretch that is not shown. These are the notes on it. Treat all of it as things you already know and remember. Do not mention these notes, and do not mention that anything is missing.

${summary}

The conversation continues from here.`;
    }

    // Records a successful summary.
    function recordSuccess(memory, { summary, coveredCount, messageCount }) {
        const state = memory || {};
        const history = Array.isArray(state.rounds) ? state.rounds.slice(-9) : [];
        history.push({
            at: new Date().toISOString(),
            messagesFolded: messageCount,
            summaryTokens: estimateTokens(summary),
        });

        return {
            summary,
            coveredCount,
            rounds: history,
            consecutiveFailures: 0,
            lastCompactedAt: new Date().toISOString(),
        };
    }

    // Records a failure. After enough of these in a row it stops trying for the
    // rest of the session, so a provider having a bad day cannot turn into a
    // summarising attempt on every single message.
    function recordFailure(memory, reason) {
        const state = memory || {};
        const failures = (Number(state.consecutiveFailures) || 0) + 1;
        return Object.assign({}, state, {
            consecutiveFailures: failures,
            lastFailure: { at: new Date().toISOString(), reason: String(reason || "") },
        });
    }

    // Checks a summary before it is trusted. A model can return an apology, a
    // refusal, or something far too short to be useful, and storing that would
    // quietly wreck the character's memory. Better to keep sending the full
    // conversation than to accept a bad summary.
    function isUsableSummary(summary, { foldedMessages } = {}) {
        if (typeof summary !== "string") return { ok: false, reason: "not-text" };

        const trimmed = summary.trim();
        if (trimmed.length < 80) return { ok: false, reason: "too-short" };

        // A refusal or a complaint about the request. Checked before the shape,
        // because a refusal also fails the shape check and knowing which it really
        // was matters when working out why a chat stopped compacting.
        if (/^(i'm sorry|i am sorry|i cannot|i can't|as an ai|sorry,)/i.test(trimmed)) {
            return { ok: false, reason: "refused" };
        }

        // It should mention at least a couple of the headings it was asked for.
        const headings = ["WHERE THINGS STAND", "WHAT IS TRUE", "BETWEEN THEM", "UNFINISHED", "RECENT EVENTS"];
        const found = headings.filter((heading) => trimmed.toUpperCase().includes(heading)).length;
        if (found < 2) return { ok: false, reason: "wrong-shape" };

        // It should be meaningfully smaller than what it replaced, otherwise there
        // is no point paying for it.
        if (foldedMessages && foldedMessages.length) {
            const before = measureMessages(foldedMessages).tokens;
            const after = estimateTokens(trimmed);
            if (after > before * 0.75) {
                return { ok: false, reason: "not-smaller", before, after };
            }
        }

        return { ok: true };
    }

    // A short line for the reader, so this never feels like something happening
    // behind their back.
    function describeMemoryState(memory, messages) {
        const state = memory || {};
        const usable = sendableMessages(messages);
        const total = measureMessages(usable).tokens;

        if (!state.summary) {
            return {
                compacted: false,
                text: `${usable.length} messages, roughly ${total.toLocaleString()} tokens sent each turn.`,
            };
        }

        const covered = Number(state.coveredCount) || 0;
        const verbatim = usable.slice(covered);
        const now = measureMessages(verbatim).tokens + estimateTokens(state.summary);
        const saved = Math.max(0, total - now);

        return {
            compacted: true,
            coveredCount: covered,
            text: `The first ${covered} messages are held as a summary, and the last ${verbatim.length} are sent word for word. That is roughly ${now.toLocaleString()} tokens a turn instead of ${total.toLocaleString()}, saving about ${saved.toLocaleString()}.`,
        };
    }

    return {
        DEFAULTS,
        CHARS_PER_TOKEN,
        estimateTokens,
        measureMessages,
        isSendable,
        sendableMessages,
        withSettings,
        shouldCompact,
        planCompaction,
        buildSummaryPrompt,
        buildSendableHistory,
        formatSummaryForPrompt,
        recordSuccess,
        recordFailure,
        isUsableSummary,
        describeMemoryState,
    };
});
