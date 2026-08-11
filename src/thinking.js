// Separating a model's reasoning from its actual reply.
//
// Why this file exists
//
// Models that reason before answering emit two different things. There is the
// internal working out, and there is the reply meant for the reader. The old
// code treated both as one blob of text, so the reasoning ended up in the chat
// bubble, and sometimes the reasoning was the only thing saved.
//
// The old code also tried to stop this by asking the model in words not to
// think. That never worked, because reasoning is not something a prompt can
// switch off. It is part of how the model runs. What we can do is ask the API
// to keep reasoning short where the API supports that, and then reliably tell
// the two kinds of output apart when they come back.
//
// Providers signal reasoning in four different ways, and we handle all of them.
//
//   1. A flag on each piece of the response. Gemini marks reasoning parts with
//      thought set to true.
//   2. A separate field alongside the reply. Ollama uses thinking, and several
//      OpenAI compatible services use reasoning or reasoning_content.
//   3. Tags inside the reply text itself. Models in the DeepSeek R1 family and
//      the Qwen thinking family write <think> ... </think> straight into the
//      content.
//   4. Nothing at all, which is the easy case.
//
// Case three is the awkward one during streaming, because a tag can be split
// across chunk boundaries. A chunk can end mid tag, so "<thi" arrives now and
// "nk>" arrives next. That is why this file has a small stateful stream reader
// rather than a plain string replace.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastThinking = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // Tag pairs we know about. Kept as plain names so we can build both the
    // opening and closing forms and match them case insensitively.
    const REASONING_TAGS = ["think", "thinking", "thought", "reasoning", "reflection"];

    // Fields that carry reasoning separately from the reply, in the order we
    // should check them.
    const REASONING_FIELDS = [
        "thinking",
        "reasoning",
        "reasoning_content",
        "reasoningContent",
        "thought",
        "thoughts",
    ];

    const MAX_TAG_LOOKAHEAD = 20; // longest possible "</reasoning>" plus slack

    function longestTagLength() {
        let longest = 0;
        REASONING_TAGS.forEach((tag) => {
            longest = Math.max(longest, tag.length + 3); // "</" + tag + ">"
        });
        return longest;
    }

    // Builds a regular expression that matches a complete reasoning block,
    // including one that was never closed, which happens when a response is cut
    // off by a token limit partway through reasoning.
    function buildBlockPattern() {
        const names = REASONING_TAGS.join("|");
        return new RegExp(`<(${names})(?:\\s[^>]*)?>([\\s\\S]*?)(?:</\\1\\s*>|$)`, "gi");
    }

    // Removes complete reasoning blocks from a finished string.
    // Returns the cleaned reply and whatever reasoning was pulled out.
    function stripReasoningTags(text) {
        if (typeof text !== "string" || !text) {
            return { reply: "", reasoning: "" };
        }

        const collected = [];
        const reply = text.replace(buildBlockPattern(), (match, tagName, inner) => {
            collected.push(String(inner || "").trim());
            return "";
        });

        return {
            reply: reply.trim(),
            reasoning: collected.filter(Boolean).join("\n\n"),
        };
    }

    // Pulls the reply out of a response object from any provider.
    //
    // Handles Gemini's candidates and parts shape, the OpenAI compatible
    // choices shape, Ollama's message shape, and a bare string. Anything it
    // cannot recognise comes back as empty rather than throwing, so a surprise
    // response shape can never take the app down.
    function extractFromResponse(response) {
        const result = { reply: "", reasoning: "", finishReason: "", truncated: false };
        if (response === null || response === undefined) return result;

        if (typeof response === "string") {
            const stripped = stripReasoningTags(response);
            result.reply = stripped.reply;
            result.reasoning = stripped.reasoning;
            return result;
        }

        if (typeof response !== "object") return result;

        const replyPieces = [];
        const reasoningPieces = [];

        const takeSeparateFields = (holder) => {
            if (!holder || typeof holder !== "object") return;
            REASONING_FIELDS.forEach((field) => {
                const value = holder[field];
                if (typeof value === "string" && value.trim()) {
                    reasoningPieces.push(value.trim());
                }
            });
        };

        // Gemini shape. Parts carrying thought set to true are reasoning, and
        // everything else is reply. This is the check the old code was missing.
        const candidates = Array.isArray(response.candidates) ? response.candidates : [];
        candidates.forEach((candidate) => {
            if (!candidate || typeof candidate !== "object") return;

            if (!result.finishReason && typeof candidate.finishReason === "string") {
                result.finishReason = candidate.finishReason;
            }

            const parts = candidate.content && Array.isArray(candidate.content.parts)
                ? candidate.content.parts
                : [];

            parts.forEach((part) => {
                if (!part || typeof part !== "object") return;
                const text = typeof part.text === "string" ? part.text : "";
                if (!text) return;
                if (part.thought === true || part.isThought === true) {
                    reasoningPieces.push(text);
                } else {
                    replyPieces.push(text);
                }
            });
        });

        // OpenAI compatible shape, which covers OpenRouter, NVIDIA NIM, Groq,
        // Cerebras, Mistral, GitHub Models, LM Studio and anything else that
        // speaks the same dialect.
        const choices = Array.isArray(response.choices) ? response.choices : [];
        choices.forEach((choice) => {
            if (!choice || typeof choice !== "object") return;

            if (!result.finishReason && typeof choice.finish_reason === "string") {
                result.finishReason = choice.finish_reason;
            }

            const message = choice.message || choice.delta;
            if (!message || typeof message !== "object") return;

            takeSeparateFields(message);
            if (typeof message.content === "string" && message.content) {
                replyPieces.push(message.content);
            }
        });

        // Ollama shape.
        if (response.message && typeof response.message === "object") {
            takeSeparateFields(response.message);
            if (typeof response.message.content === "string" && response.message.content) {
                replyPieces.push(response.message.content);
            }
        }

        // Reasoning fields sometimes sit at the top level.
        takeSeparateFields(response);

        // Some SDKs expose a text getter that already joins the parts. Only use
        // it when we found nothing else, because on some versions that getter
        // includes reasoning parts, which is the exact bug we are fixing.
        if (!replyPieces.length) {
            if (typeof response.text === "string" && response.text) {
                replyPieces.push(response.text);
            } else if (typeof response.response === "string" && response.response) {
                replyPieces.push(response.response);
            }
        }

        if (!result.finishReason && typeof response.finish_reason === "string") {
            result.finishReason = response.finish_reason;
        }
        if (!result.finishReason && typeof response.finishReason === "string") {
            result.finishReason = response.finishReason;
        }

        // Even after splitting by flag or field, the reply text can still have
        // tags embedded in it, so clean it as well.
        const stripped = stripReasoningTags(replyPieces.join(""));
        if (stripped.reasoning) reasoningPieces.push(stripped.reasoning);

        result.reply = stripped.reply;
        result.reasoning = reasoningPieces.filter(Boolean).join("\n\n").trim();

        const reason = String(result.finishReason || "").toUpperCase();
        result.truncated = reason === "MAX_TOKENS" || reason === "LENGTH";

        return result;
    }

    // A stream reader that copes with tags split across chunk boundaries.
    //
    // Feed it whatever arrives. It returns only the text that is safe to show
    // right now. When a chunk ends with something that might be the start of a
    // tag, that fragment is held back until the next chunk proves what it is.
    function createStreamFilter() {
        let pending = "";        // text held back, might be a partial tag
        let reasoningDepth = 0;  // how many reasoning tags we are inside
        let reasoning = "";      // reasoning collected so far
        let reply = "";          // reply collected so far

        const openPattern = new RegExp(`^<(${REASONING_TAGS.join("|")})(?:\\s[^>]*)?>`, "i");
        const closePattern = new RegExp(`^</(${REASONING_TAGS.join("|")})\\s*>`, "i");
        const holdBack = Math.max(longestTagLength(), MAX_TAG_LOOKAHEAD);

        // Could this trailing text still grow into a tag?
        function mightBeStartOfTag(text) {
            if (!text) return false;
            const lower = text.toLowerCase();
            const candidates = [];
            REASONING_TAGS.forEach((tag) => {
                candidates.push(`<${tag}>`);
                candidates.push(`</${tag}>`);
            });
            // True when the held text is a prefix of any known tag.
            return candidates.some((candidate) => candidate.indexOf(lower) === 0)
                || /^<\/?[a-z]*$/i.test(text);
        }

        function consume(chunk) {
            pending += typeof chunk === "string" ? chunk : "";
            let emitted = "";

            while (pending.length) {
                const nextAngle = pending.indexOf("<");

                if (nextAngle === -1) {
                    // No tag start anywhere. Everything is safe to release.
                    if (reasoningDepth > 0) {
                        reasoning += pending;
                    } else {
                        emitted += pending;
                    }
                    pending = "";
                    break;
                }

                if (nextAngle > 0) {
                    // Release the plain text sitting before the angle bracket.
                    const plain = pending.slice(0, nextAngle);
                    if (reasoningDepth > 0) {
                        reasoning += plain;
                    } else {
                        emitted += plain;
                    }
                    pending = pending.slice(nextAngle);
                    continue;
                }

                // pending now starts with "<".
                const open = pending.match(openPattern);
                if (open) {
                    reasoningDepth += 1;
                    pending = pending.slice(open[0].length);
                    continue;
                }

                const close = pending.match(closePattern);
                if (close) {
                    if (reasoningDepth > 0) reasoningDepth -= 1;
                    pending = pending.slice(close[0].length);
                    continue;
                }

                // It starts with "<" but is not a reasoning tag yet. If it could
                // still become one once more text arrives, hold it. Otherwise it
                // is ordinary text such as a less than sign in dialogue.
                if (pending.length < holdBack && mightBeStartOfTag(pending)) {
                    break; // wait for more
                }

                if (reasoningDepth > 0) {
                    reasoning += pending[0];
                } else {
                    emitted += pending[0];
                }
                pending = pending.slice(1);
            }

            reply += emitted;
            return emitted;
        }

        // Called once the stream ends. Releases anything still held back and
        // reports whether the response stopped in the middle of reasoning.
        function finish() {
            let tail = "";
            if (pending) {
                if (reasoningDepth > 0) {
                    reasoning += pending;
                } else {
                    tail = pending;
                    reply += tail;
                }
                pending = "";
            }

            return {
                tail,
                reply: reply.trim(),
                reasoning: reasoning.trim(),
                endedInsideReasoning: reasoningDepth > 0,
            };
        }

        return {
            consume,
            finish,
            get reply() { return reply; },
            get reasoning() { return reasoning; },
            get insideReasoning() { return reasoningDepth > 0; },
        };
    }

    // Reads one streaming chunk from any provider and returns the reply text
    // and reasoning text it carries, before tag filtering is applied.
    function readChunk(chunk) {
        const out = { replyText: "", reasoningText: "", finishReason: "" };
        if (!chunk) return out;

        if (typeof chunk === "string") {
            out.replyText = chunk;
            return out;
        }
        if (typeof chunk !== "object") return out;

        const extracted = extractFromResponseWithoutStripping(chunk);
        out.replyText = extracted.reply;
        out.reasoningText = extracted.reasoning;
        out.finishReason = extracted.finishReason;
        return out;
    }

    // Same shape walking as extractFromResponse but it does not strip tags,
    // because during streaming the stream filter handles tags across chunks.
    function extractFromResponseWithoutStripping(response) {
        const result = { reply: "", reasoning: "", finishReason: "" };
        const replyPieces = [];
        const reasoningPieces = [];

        const takeSeparateFields = (holder) => {
            if (!holder || typeof holder !== "object") return;
            REASONING_FIELDS.forEach((field) => {
                const value = holder[field];
                if (typeof value === "string" && value) reasoningPieces.push(value);
            });
        };

        const candidates = Array.isArray(response.candidates) ? response.candidates : [];
        candidates.forEach((candidate) => {
            if (!candidate || typeof candidate !== "object") return;
            if (!result.finishReason && typeof candidate.finishReason === "string") {
                result.finishReason = candidate.finishReason;
            }
            const parts = candidate.content && Array.isArray(candidate.content.parts)
                ? candidate.content.parts
                : [];
            parts.forEach((part) => {
                if (!part || typeof part !== "object") return;
                const text = typeof part.text === "string" ? part.text : "";
                if (!text) return;
                if (part.thought === true || part.isThought === true) {
                    reasoningPieces.push(text);
                } else {
                    replyPieces.push(text);
                }
            });
        });

        const choices = Array.isArray(response.choices) ? response.choices : [];
        choices.forEach((choice) => {
            if (!choice || typeof choice !== "object") return;
            if (!result.finishReason && typeof choice.finish_reason === "string") {
                result.finishReason = choice.finish_reason;
            }
            const message = choice.delta || choice.message;
            if (!message || typeof message !== "object") return;
            takeSeparateFields(message);
            if (typeof message.content === "string" && message.content) {
                replyPieces.push(message.content);
            }
        });

        if (response.message && typeof response.message === "object") {
            takeSeparateFields(response.message);
            if (typeof response.message.content === "string" && response.message.content) {
                replyPieces.push(response.message.content);
            }
        }

        takeSeparateFields(response);

        if (!replyPieces.length && typeof response.text === "string" && response.text) {
            replyPieces.push(response.text);
        }
        if (!replyPieces.length && typeof response.response === "string" && response.response) {
            replyPieces.push(response.response);
        }

        result.reply = replyPieces.join("");
        result.reasoning = reasoningPieces.join("");
        return result;
    }

    // The last line of defence before a reply is saved.
    //
    // If the model produced reasoning and nothing else, we must not save the
    // reasoning as though it were the character speaking. That is the case
    // where the old app posted a message containing only the model's working
    // out. This returns a clear verdict instead so the caller can retry or show
    // an honest message.
    function verifyReply({ reply, reasoning, truncated, endedInsideReasoning }) {
        const cleanReply = typeof reply === "string" ? reply.trim() : "";
        const hasReasoning = Boolean(reasoning && String(reasoning).trim());

        if (cleanReply) {
            return { ok: true, reply: cleanReply, problem: null };
        }

        if (endedInsideReasoning || (hasReasoning && truncated)) {
            return {
                ok: false,
                reply: "",
                problem: "ran-out-of-room",
                // Written for the person reading it, not for a log file.
                message: "The model used its whole response limit on reasoning and never got to the reply. Raise the response token limit in Settings, or pick a model that reasons less.",
            };
        }

        if (hasReasoning) {
            return {
                ok: false,
                reply: "",
                problem: "reasoning-only",
                message: "The model returned only its reasoning and no reply. Try sending again.",
            };
        }

        return {
            ok: false,
            reply: "",
            problem: "empty",
            message: "The model returned an empty response. Try sending again.",
        };
    }

    return {
        REASONING_TAGS,
        REASONING_FIELDS,
        stripReasoningTags,
        extractFromResponse,
        createStreamFilter,
        readChunk,
        verifyReply,
    };
});
