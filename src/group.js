// Group chats.
//
// The hard part of a group chat is not showing several characters in one thread. It
// is deciding who speaks next in a way that feels like a conversation rather than a
// queue, without spending an API call every turn just to ask.
//
// So the choice is made here, from the text and the recent history, and it costs
// nothing. There is an optional mode that asks a model to direct instead, for when
// you would rather spend the requests, but the default needs no extra call at all.
//
// What it pays attention to, in order of weight:
//
//   Being spoken to.      If you name someone, they answer. Nothing outranks this.
//   Being asked back.     If someone asked you a question and you answered without
//                         naming anyone, they should be the one to pick it up.
//   Having just spoken.   Whoever spoke last steps back, so one character cannot run
//                         away with the conversation.
//   Having been quiet.    Someone who has not spoken for a while gets a nudge
//                         forward, so nobody is forgotten.
//   Being relevant.       Words in your message that match a character's description
//                         pull them in.
//
// The result is stable rather than random. The same message in the same conversation
// picks the same speaker, so pressing regenerate does not shuffle the room. A small
// tie breaker derived from the message itself keeps it from feeling mechanical when
// scores are level.
//
// Nothing here reads or writes app state, so all of it can be tested directly.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastGroup = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const DEFAULTS = {
        // How many characters may reply to one message before it stops and waits for
        // you. Two keeps it lively without a runaway chain of API calls.
        maxRepliesPerTurn: 2,

        // How many recent messages are looked at when working out who has been quiet
        // and who just spoke.
        recentWindow: 14,

        // Someone who just spoke is pushed down by this much.
        justSpokePenalty: 35,

        // And pushed down further for every turn they have taken beyond a fair share
        // of the recent conversation. This is what stops one character running the
        // room. It matters because characters in a roleplay end on a question
        // constantly, and answering a question is otherwise a strong pull, so without
        // this the same character would keep earning the next turn.
        dominancePenalty: 30,
        dominanceWindow: 6,

        // Per message of silence, up to a limit, someone is nudged up by this much.
        silenceBonus: 8,
        maxSilenceBonus: 40,

        // Somebody who has not spoken at all yet ranks above everybody who has.
        //
        // This has to sit strictly above maxSilenceBonus. When it did not, a character
        // who had spoken a few messages ago scored the same as one who had never spoken,
        // because the silence bonus had already reached its limit. With the scores level
        // the tie breaker decided, and since the tie breaker is deliberately stable the
        // same character lost every single time. In a simulated sixty turn conversation
        // one of four characters never spoke once.
        neverSpokeBonus: 75,

        // Being named in the message.
        directAddressScore: 1000,

        // Being the one who asked the question that was just answered.
        //
        // Deliberately below the bonus for never having spoken.
        //
        // These two pull against each other and both matter. Setting this higher made a
        // character who asks questions win every turn, which in a roleplay is every
        // character, and a simulated sixty turn conversation left one of four silent
        // throughout. Setting it here means that early on, while others have not spoken
        // at all, a new voice comes in rather than a two person dialogue forming, and
        // once everybody has spoken the one who asked you something does get to follow
        // up. That is the better trade in both halves of a conversation.
        askedQuestionScore: 120,

        // Each description word matching the message.
        relevanceScore: 12,
        maxRelevanceScore: 60,
    };

    // Words too common to say anything about who a message is aimed at.
    const STOP_WORDS = new Set([
        "the", "a", "an", "and", "or", "but", "if", "then", "so", "of", "to", "in",
        "on", "at", "by", "for", "with", "from", "as", "is", "are", "was", "were",
        "be", "been", "being", "do", "does", "did", "have", "has", "had", "will",
        "would", "could", "should", "can", "may", "might", "must", "i", "you", "he",
        "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your",
        "his", "its", "our", "their", "this", "that", "these", "those", "what",
        "who", "which", "when", "where", "why", "how", "all", "any", "both", "each",
        "more", "most", "other", "some", "such", "no", "not", "only", "own", "same",
        "than", "too", "very", "just", "now", "also", "there", "here", "one", "two",
        "get", "got", "like", "well", "really", "about", "up", "out", "down", "over",
    ]);

    function withSettings(settings) {
        const merged = Object.assign({}, DEFAULTS, settings || {});
        merged.maxRepliesPerTurn = Math.max(1, Math.min(6, parseInt(merged.maxRepliesPerTurn, 10) || DEFAULTS.maxRepliesPerTurn));
        return merged;
    }

    // A stable number from a string, used only as a tie breaker. The same message
    // always produces the same value, so the room does not reshuffle on regenerate.
    function stableHash(text) {
        let hash = 0;
        const value = String(text || "");
        for (let i = 0; i < value.length; i += 1) {
            hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        }
        return Math.abs(hash);
    }

    // The names a character might be called: the full name, and the first word of it
    // when that is distinctive enough to be a name on its own.
    function nameVariants(character) {
        if (!character || !character.name) return [];
        const full = String(character.name).trim();
        if (!full) return [];

        const variants = [full.toLowerCase()];
        const firstWord = full.split(/\s+/)[0];
        if (firstWord && firstWord.length >= 3 && firstWord.toLowerCase() !== full.toLowerCase()) {
            variants.push(firstWord.toLowerCase());
        }
        return variants;
    }

    // Does this text address that character by name?
    //
    // Matched on word boundaries so mentioning Ram does not also match Rem, and a
    // character called Al does not match the word "always".
    function mentionsCharacter(text, character) {
        const haystack = String(text || "").toLowerCase();
        if (!haystack) return false;

        return nameVariants(character).some((variant) => {
            // Escape anything in a name that would otherwise be a pattern.
            const safe = variant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            return new RegExp(`(^|[^\\p{L}\\p{N}])${safe}([^\\p{L}\\p{N}]|$)`, "u").test(haystack);
        });
    }

    // Everyone named in the text, in the order they appear, so "Ram, then Rem" gives
    // Ram first.
    function findAddressedCharacters(text, roster) {
        const haystack = String(text || "").toLowerCase();
        const found = [];

        (roster || []).forEach((character) => {
            if (!mentionsCharacter(text, character)) return;
            let earliest = Infinity;
            nameVariants(character).forEach((variant) => {
                const at = haystack.indexOf(variant);
                if (at !== -1 && at < earliest) earliest = at;
            });
            found.push({ character, at: earliest });
        });

        return found.sort((a, b) => a.at - b.at).map((entry) => entry.character);
    }

    // Does this look like a question put to the whole room rather than to one person?
    function addressesEveryone(text) {
        const value = String(text || "").toLowerCase();
        if (!value) return false;
        return /\b(everyone|everybody|all of you|you all|you both|anyone|you guys|y'all|yall|both of you)\b/.test(value)
            || /\bwhat do you (all|both|guys) think\b/.test(value);
    }

    // Meaningful words in a piece of text, for matching a message against a
    // character's description.
    function keywordsOf(text) {
        return String(text || "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .split(/\s+/)
            .filter((word) => word.length > 3 && !STOP_WORDS.has(word));
    }

    // Reads the recent history: who spoke, how long ago, and whether the last thing a
    // character said was a question.
    function readRecentActivity(messages, settings) {
        const config = withSettings(settings);
        const usable = (Array.isArray(messages) ? messages : []).filter((message) =>
            message && !message.isDeleted && !message.isTyping && !message.isSystem
        );

        const window = usable.slice(-config.recentWindow);
        const lastSpokeAt = {};      // character id to how many messages ago
        let lastSpeakerId = null;
        let lastQuestionerId = null;

        window.forEach((message, index) => {
            if (message.isUser || !message.characterId) return;
            const messagesAgo = window.length - 1 - index;
            // Keep the most recent appearance.
            if (lastSpokeAt[message.characterId] === undefined || messagesAgo < lastSpokeAt[message.characterId]) {
                lastSpokeAt[message.characterId] = messagesAgo;
            }
        });

        // Walk backwards for the last character to speak, and for the last one who
        // ended on a question.
        for (let i = usable.length - 1; i >= 0; i -= 1) {
            const message = usable[i];
            if (message.isUser || !message.characterId) continue;
            if (!lastSpeakerId) lastSpeakerId = message.characterId;
            if (!lastQuestionerId && /\?\s*$/.test(String(message.content || "").trim())) {
                lastQuestionerId = message.characterId;
            }
            if (lastSpeakerId && lastQuestionerId) break;
        }

        // How much of the recent talking each character has done, used to spot one of
        // them taking over.
        const characterTurns = usable
            .filter((message) => !message.isUser && message.characterId)
            .slice(-config.dominanceWindow);

        const turnsTaken = {};
        characterTurns.forEach((message) => {
            turnsTaken[message.characterId] = (turnsTaken[message.characterId] || 0) + 1;
        });

        return {
            lastSpokeAt,
            lastSpeakerId,
            lastQuestionerId,
            turnsTaken,
            recentTurnCount: characterTurns.length,
            considered: window.length,
        };
    }

    // The decision.
    //
    // Returns the characters who should reply, in order, along with why, so the
    // reasoning can be shown rather than being a black box.
    function chooseSpeakers({ message, roster, messages, settings, forcedCharacterId }) {
        const config = withSettings(settings);
        const present = (Array.isArray(roster) ? roster : []).filter((c) => c && c.id);

        if (!present.length) {
            return { speakers: [], reason: "nobody-here", scores: [] };
        }

        // You picked someone, so that settles it.
        if (forcedCharacterId) {
            const chosen = present.find((c) => c.id === forcedCharacterId);
            if (chosen) {
                return { speakers: [chosen], reason: "you-chose", scores: [] };
            }
        }

        if (present.length === 1) {
            return { speakers: [present[0]], reason: "only-one-here", scores: [] };
        }

        const text = String(message || "");
        const activity = readRecentActivity(messages, config);

        // Named directly. Everyone named replies, in the order you named them.
        const addressed = findAddressedCharacters(text, present);
        if (addressed.length) {
            return {
                speakers: addressed.slice(0, config.maxRepliesPerTurn),
                reason: addressed.length === 1 ? "spoken-to" : "several-spoken-to",
                scores: [],
            };
        }

        // Asked the room. Let a couple of them answer.
        if (addressesEveryone(text)) {
            const scored = scoreEveryone(text, present, activity, config);
            return {
                speakers: scored.slice(0, config.maxRepliesPerTurn).map((entry) => entry.character),
                reason: "asked-the-room",
                scores: scored,
            };
        }

        const scored = scoreEveryone(text, present, activity, config);
        const top = scored[0];

        return {
            speakers: top ? [top.character] : [],
            reason: top ? top.topReason : "nobody-suitable",
            scores: scored,
        };
    }

    // Scores everyone in the room and sorts them best first.
    function scoreEveryone(text, roster, activity, settings) {
        const config = withSettings(settings);
        const messageWords = new Set(keywordsOf(text));
        const tieBreaker = stableHash(text);

        const scored = roster.map((character, index) => {
            let score = 0;
            const reasons = [];

            // Whoever just spoke steps back, so one voice does not dominate.
            if (activity.lastSpeakerId === character.id) {
                score -= config.justSpokePenalty;
                reasons.push("just spoke");
            }

            // If they asked something and you answered without naming anyone, they
            // are the natural one to carry on.
            if (activity.lastQuestionerId === character.id && activity.lastSpeakerId === character.id) {
                score += config.askedQuestionScore;
                reasons.push("asked you a question");
            }

            // Quiet for a while, so nudge them forward.
            const spokeAgo = activity.lastSpokeAt[character.id];
            if (spokeAgo === undefined) {
                score += config.neverSpokeBonus;
                reasons.push("has not spoken");
            } else {
                const bonus = Math.min(config.maxSilenceBonus, spokeAgo * config.silenceBonus);
                score += bonus;
                if (bonus > 0) reasons.push("quiet for a bit");
            }

            // Taking more than a fair share of the recent turns.
            const fairShare = activity.recentTurnCount / Math.max(1, roster.length);
            const taken = activity.turnsTaken[character.id] || 0;
            if (taken > fairShare) {
                const excess = taken - fairShare;
                score -= excess * config.dominancePenalty;
                if (excess >= 1) reasons.push("has been doing most of the talking");
            }

            // Their description overlapping what you said.
            const profile = character.enhancedContext || character.userContext || "";
            const profileWords = new Set(keywordsOf(profile));
            let overlap = 0;
            messageWords.forEach((word) => { if (profileWords.has(word)) overlap += 1; });
            if (overlap) {
                const bonus = Math.min(config.maxRelevanceScore, overlap * config.relevanceScore);
                score += bonus;
                reasons.push("this is their sort of thing");
            }

            // Keeps level scores from always resolving the same way, while staying
            // stable for the same message.
            score += ((tieBreaker + index * 7919) % 11) / 10;

            return {
                character,
                score,
                reasons,
                topReason: reasons[0] || "their turn",
            };
        });

        return scored.sort((a, b) => b.score - a.score);
    }

    // After a character speaks, should another one answer them?
    //
    // Only when the one who spoke actually addressed somebody else in the room. That
    // keeps a chain purposeful rather than everybody piling in, and it caps the number
    // of API calls one message can cause.
    function chooseFollowUp({ lastMessage, lastSpeakerId, roster, repliesSoFar, settings }) {
        const config = withSettings(settings);

        if (repliesSoFar >= config.maxRepliesPerTurn) {
            return { speaker: null, reason: "reached-the-limit" };
        }

        const others = (roster || []).filter((c) => c && c.id && c.id !== lastSpeakerId);
        if (!others.length) return { speaker: null, reason: "nobody-else" };

        const addressed = findAddressedCharacters(lastMessage, others);
        if (addressed.length) {
            return { speaker: addressed[0], reason: "was-spoken-to" };
        }

        return { speaker: null, reason: "nothing-aimed-at-anyone" };
    }

    // How each character sees the room.
    //
    // Two things matter here. They need to know who else is present, or they cannot
    // react to each other. And they need to be told firmly to write only their own
    // lines, because otherwise a model will happily write everybody's dialogue and the
    // group falls apart into one voice doing impressions.
    function buildRoomInstruction({ speaker, roster, userName }) {
        const others = (roster || []).filter((c) => c && c.id && speaker && c.id !== speaker.id);
        if (!others.length) return "";

        const who = userName || "the person you are talking to";

        const introductions = others.map((character) => {
            const profile = String(character.enhancedContext || character.userContext || "").trim();
            const firstLine = profile.split(/\n|\.\s/)[0] || "";
            const summary = firstLine.length > 180 ? `${firstLine.slice(0, 180)}...` : firstLine;
            return summary ? `- ${character.name}: ${summary}` : `- ${character.name}`;
        }).join("\n");

        return `THIS IS A GROUP CONVERSATION.

Also here, besides you and ${who}:
${introductions}

Every line in the conversation is labelled with who said it. Read those labels: some
of what has been said was said by the others, not by ${who}, and you can respond to
them as readily as to ${who}.

Rules for a group, and these matter more than anything else about format:
- Write only as ${speaker.name}. Only your own words, your own actions, your own thoughts.
- Never write dialogue for the others. Never describe what they say or do next. If you
  address one of them, stop and let them answer.
- Do not label your own reply with your name. Just speak.
- React to the others as your character would. Agree, interrupt, disagree, tease, ignore
  them, whatever fits who you are.
- You do not have to acknowledge everyone. A real conversation is uneven.`;
    }

    // Labels the history so a model can tell who said what.
    //
    // In a one to one chat everything the character said is simply theirs. In a group,
    // several characters share the same role in the transcript, so without labels the
    // model sees one undifferentiated voice and the characters blur into each other.
    function labelHistoryForGroup(messages, roster, userName) {
        const byId = {};
        (roster || []).forEach((character) => {
            if (character && character.id) byId[character.id] = character.name || "Someone";
        });

        return (Array.isArray(messages) ? messages : [])
            .filter((message) => message && !message.isDeleted && !message.isTyping && !message.isSystem && !message.isError)
            .map((message) => {
                const content = String(message.content || "").trim();
                if (!content) return null;

                if (message.isUser) {
                    return { role: "user", name: userName || "You", content };
                }

                const name = byId[message.characterId] || "Someone";
                return { role: "character", name, content, characterId: message.characterId };
            })
            .filter(Boolean);
    }

    // Turns the labelled history into the alternating shape the APIs expect.
    //
    // Everything that is not the character about to speak is folded into the user side
    // with a name in front of it, because that is how a model is told "this was said to
    // you by someone else". The speaker's own past lines stay on the model side so they
    // read as their own voice.
    function buildHistoryForSpeaker(labelled, speakerId) {
        const turns = [];

        (labelled || []).forEach((entry) => {
            const isSpeaker = entry.role === "character" && entry.characterId === speakerId;
            const role = isSpeaker ? "model" : "user";
            const text = isSpeaker ? entry.content : `${entry.name}: ${entry.content}`;

            const previous = turns[turns.length - 1];
            if (previous && previous.role === role) {
                // Consecutive turns on the same side have to be merged, because these
                // APIs reject two user turns in a row.
                previous.content += `\n\n${text}`;
            } else {
                turns.push({ role, content: text });
            }
        });

        return turns;
    }

    // A short line explaining who was picked and why, for the interface.
    function describeChoice(decision) {
        if (!decision || !decision.speakers || !decision.speakers.length) {
            return "Nobody is set to reply.";
        }

        const names = decision.speakers.map((c) => c.name).join(" and ");

        switch (decision.reason) {
            case "you-chose": return `${names} is replying because you picked them.`;
            case "spoken-to": return `${names} is replying because you spoke to them.`;
            case "several-spoken-to": return `${names} are replying because you named them.`;
            case "asked-the-room": return `${names} are answering because you asked everyone.`;
            case "only-one-here": return `${names} is the only one here.`;
            case "asked you a question": return `${names} is replying because they asked you something.`;
            case "has not spoken": return `${names} is replying because they have been quiet.`;
            case "quiet for a bit": return `${names} is replying, having been quiet for a bit.`;
            case "this is their sort of thing": return `${names} is replying because this is their sort of thing.`;
            default: return `${names} is replying.`;
        }
    }

    // A name for a new group, from its members. Used as a default that you can change.
    function suggestGroupName(members) {
        const names = (Array.isArray(members) ? members : [])
            .map((c) => (c && c.name ? String(c.name).split(/\s+/)[0] : ""))
            .filter(Boolean);

        if (!names.length) return "New group";
        if (names.length === 1) return names[0];
        if (names.length === 2) return `${names[0]} and ${names[1]}`;
        if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
        return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
    }

    return {
        DEFAULTS,
        withSettings,
        stableHash,
        nameVariants,
        mentionsCharacter,
        findAddressedCharacters,
        addressesEveryone,
        keywordsOf,
        readRecentActivity,
        chooseSpeakers,
        scoreEveryone,
        chooseFollowUp,
        buildRoomInstruction,
        labelHistoryForGroup,
        buildHistoryForSpeaker,
        describeChoice,
        suggestGroupName,
    };
});
