// Tests for group chats.
//
// The turn taking is the part worth testing hardest, because a group that always
// picks the same character, or that lets one character answer everything, stops
// feeling like a conversation.

const test = require("node:test");
const assert = require("node:assert");
const G = require("../src/group.js");

const RAM = { id: "ram000000001", name: "Ram", userContext: "A sharp tongued maid at the Mathers estate. Blunt, teasing, fiercely protective of her sister." };
const REM = { id: "rem000000002", name: "Rem", userContext: "A devoted maid who works hard and worries about everyone. Gentle and earnest." };
const ROSWAAL = { id: "ros000000003", name: "Roswaal L. Mathers", userContext: "A theatrical margrave who runs the estate. Speaks with drawn out vowels and hides calculation behind a clownish manner." };
const SUBARU = { id: "sub000000004", name: "Subaru Natsuki", userContext: "An ordinary young man from another world who keeps trying despite everything." };

const ROSTER = [RAM, REM, ROSWAAL, SUBARU];

function said(characterId, content) {
    return { id: `m${Math.random()}`, characterId, content, isUser: false, isDeleted: false };
}
function youSaid(content) {
    return { id: `u${Math.random()}`, content, isUser: true, isDeleted: false };
}

// --- Being spoken to ---

test("naming someone makes them reply", () => {
    const decision = G.chooseSpeakers({ message: "Ram, what do you think?", roster: ROSTER, messages: [] });
    assert.strictEqual(decision.speakers.length, 1);
    assert.strictEqual(decision.speakers[0].id, RAM.id);
    assert.strictEqual(decision.reason, "spoken-to");
});

test("a name is matched on word boundaries, so Ram does not catch Rem", () => {
    assert.strictEqual(G.mentionsCharacter("Ram is here", RAM), true);
    assert.strictEqual(G.mentionsCharacter("Ram is here", REM), false);
    assert.strictEqual(G.mentionsCharacter("Rem is here", RAM), false);
});

test("a short name inside a longer word does not count", () => {
    // A character called Ram must not be picked out of "rambling" or "program".
    assert.strictEqual(G.mentionsCharacter("stop rambling", RAM), false);
    assert.strictEqual(G.mentionsCharacter("the program works", RAM), false);
});

test("a first name works for a character with a long full name", () => {
    assert.strictEqual(G.mentionsCharacter("Roswaal, explain yourself", ROSWAAL), true);
    assert.strictEqual(G.mentionsCharacter("Subaru, are you alright?", SUBARU), true);
});

test("naming two people has them both reply, in the order named", () => {
    const decision = G.chooseSpeakers({
        message: "Rem, and then Ram, tell me what happened",
        roster: ROSTER,
        messages: [],
        settings: { maxRepliesPerTurn: 3 },
    });
    assert.strictEqual(decision.speakers.length, 2);
    assert.strictEqual(decision.speakers[0].id, REM.id, "Rem was named first");
    assert.strictEqual(decision.speakers[1].id, RAM.id);
});

test("naming people never exceeds the reply limit", () => {
    const decision = G.chooseSpeakers({
        message: "Ram, Rem, Roswaal, Subaru, all of you",
        roster: ROSTER,
        messages: [],
        settings: { maxRepliesPerTurn: 2 },
    });
    assert.strictEqual(decision.speakers.length, 2);
});

// --- Asking the room ---

test("asking everyone gets more than one answer", () => {
    const decision = G.chooseSpeakers({
        message: "What do you all think about that?",
        roster: ROSTER,
        messages: [],
        settings: { maxRepliesPerTurn: 2 },
    });
    assert.strictEqual(decision.reason, "asked-the-room");
    assert.strictEqual(decision.speakers.length, 2);
});

test("various ways of addressing the room are recognised", () => {
    ["everyone", "you all", "both of you", "anyone here?", "what do you guys think"].forEach((phrase) => {
        assert.strictEqual(G.addressesEveryone(phrase), true, `${phrase} should address the room`);
    });
    assert.strictEqual(G.addressesEveryone("how are you today"), false);
});

// --- Not letting one character dominate ---

test("whoever just spoke steps back", () => {
    // Ram's last line is a statement, not a question, so nothing pulls her back in.
    const messages = [youSaid("hello"), said(RAM.id, "Fine. Whatever you say.")];
    const decision = G.chooseSpeakers({ message: "I was just saying hi", roster: ROSTER, messages });
    assert.notStrictEqual(decision.speakers[0].id, RAM.id, "Ram spoke last, so someone else should go");
});

test("a character who has been doing most of the talking is pushed down", () => {
    // This is the case that matters, because characters end on questions constantly
    // and answering a question is otherwise a strong pull. Without a check on how much
    // of the room one character has taken, the same one would keep earning the turn.
    const messages = [
        youSaid("hi"),
        said(RAM.id, "Yes? What is it?"),
        youSaid("nothing"),
        said(RAM.id, "Then why speak at all, hm?"),
        youSaid("just talking"),
        said(RAM.id, "How tiresome. Anything else?"),
    ];
    const decision = G.chooseSpeakers({ message: "not really", roster: ROSTER, messages });
    assert.notStrictEqual(decision.speakers[0].id, RAM.id,
        "Ram has taken every turn, so someone else should go even though she asked something");
});

test("someone who just spoke still answers if you name them", () => {
    const messages = [youSaid("hello"), said(RAM.id, "What is it now?")];
    const decision = G.chooseSpeakers({ message: "Ram, I meant you", roster: ROSTER, messages });
    assert.strictEqual(decision.speakers[0].id, RAM.id, "being named beats having just spoken");
});

test("a character who has not spoken gets pulled in", () => {
    // Three of them have been talking, Subaru has not said a word.
    const messages = [
        youSaid("hi"), said(RAM.id, "hm"), said(REM.id, "hello"), said(ROSWAAL.id, "hoo"),
        said(RAM.id, "again"), said(REM.id, "again"),
    ];
    const scored = G.scoreEveryone("anything at all", ROSTER, G.readRecentActivity(messages), {});
    const subaruRank = scored.findIndex((entry) => entry.character.id === SUBARU.id);
    assert.ok(subaruRank <= 1, `the silent one should be near the front, was at ${subaruRank}`);
});

test("over many turns the conversation spreads across the room", () => {
    // The real test of a group: nobody should end up answering everything.
    let messages = [youSaid("Let us begin.")];
    const counts = {};

    for (let turn = 0; turn < 30; turn += 1) {
        const decision = G.chooseSpeakers({
            message: `Turn number ${turn}, carry on.`,
            roster: ROSTER,
            messages,
        });
        const speaker = decision.speakers[0];
        assert.ok(speaker, "someone should always be chosen");
        counts[speaker.id] = (counts[speaker.id] || 0) + 1;
        messages = messages.concat([said(speaker.id, "something"), youSaid(`Turn number ${turn + 1}, carry on.`)]);
    }

    const everyone = Object.keys(counts);
    assert.strictEqual(everyone.length, 4, `all four should get a turn, got ${everyone.length}`);

    const most = Math.max(...Object.values(counts));
    assert.ok(most <= 13, `no one should dominate, the busiest took ${most} of 30`);
});

// --- Carrying on a thread ---

test("someone who asked you a question picks it back up", () => {
    // Once everybody has had a turn, answering a direct question is the strongest pull,
    // because a character asking you something and then ignoring your answer reads as
    // though nobody was listening.
    const messages = [
        youSaid("I arrived today."),
        said(RAM.id, "Took your time."),
        said(ROSWAAL.id, "Hoooow lovely."),
        said(SUBARU.id, "Hey, good to see you."),
        youSaid("Good to be here."),
        said(REM.id, "Oh! And how was the journey, are you tired?"),
    ];
    const decision = G.chooseSpeakers({ message: "It was long but fine", roster: ROSTER, messages });
    assert.strictEqual(decision.speakers[0].id, REM.id, "Rem asked, so Rem should follow up");
});

test("early on, a character who has not spoken comes in ahead of a follow up", () => {
    // The other half of the trade above. Two messages into a group chat, three of the
    // four have never said anything, and letting one of them in beats letting the first
    // speaker carry on into a two person conversation.
    const messages = [
        youSaid("I arrived today."),
        said(REM.id, "Oh! And how was the journey, are you tired?"),
    ];
    const decision = G.chooseSpeakers({ message: "It was long but fine", roster: ROSTER, messages });
    assert.notStrictEqual(decision.speakers[0].id, REM.id,
        "someone who has not spoken at all should get the turn this early");
});

// --- Relevance ---

test("a message about someone's own subject pulls them in", () => {
    const messages = [youSaid("hello"), said(SUBARU.id, "hey")];
    const decision = G.chooseSpeakers({
        message: "Tell me about the estate and being a maid here",
        roster: ROSTER,
        messages,
    });
    // Ram and Rem are both maids at the estate, so one of them should come forward.
    assert.ok([RAM.id, REM.id].includes(decision.speakers[0].id),
        `expected a maid, got ${decision.speakers[0].name}`);
});

// --- Choosing manually ---

test("picking someone yourself overrides everything", () => {
    const messages = [youSaid("hi"), said(RAM.id, "yes?")];
    const decision = G.chooseSpeakers({
        message: "Rem, what about you?",
        roster: ROSTER,
        messages,
        forcedCharacterId: ROSWAAL.id,
    });
    assert.strictEqual(decision.speakers[0].id, ROSWAAL.id);
    assert.strictEqual(decision.reason, "you-chose");
});

test("forcing someone who is not in the room is ignored", () => {
    const decision = G.chooseSpeakers({
        message: "hello",
        roster: ROSTER,
        messages: [],
        forcedCharacterId: "someone-not-here",
    });
    assert.ok(decision.speakers.length >= 1, "it should still pick someone");
    assert.notStrictEqual(decision.reason, "you-chose");
});

// --- Being stable ---

test("the same message picks the same speaker every time", () => {
    // Regenerating should not shuffle the room.
    const messages = [youSaid("hi"), said(RAM.id, "yes?")];
    const first = G.chooseSpeakers({ message: "so what happens now", roster: ROSTER, messages });
    for (let i = 0; i < 20; i += 1) {
        const again = G.chooseSpeakers({ message: "so what happens now", roster: ROSTER, messages });
        assert.strictEqual(again.speakers[0].id, first.speakers[0].id);
    }
});

// --- Follow ups ---

test("a character who addresses another lets them answer", () => {
    const follow = G.chooseFollowUp({
        lastMessage: "Rem, would you fetch the tea?",
        lastSpeakerId: RAM.id,
        roster: ROSTER,
        repliesSoFar: 1,
        settings: { maxRepliesPerTurn: 3 },
    });
    assert.ok(follow.speaker);
    assert.strictEqual(follow.speaker.id, REM.id);
});

test("a character talking to nobody in particular does not trigger a chain", () => {
    const follow = G.chooseFollowUp({
        lastMessage: "What a tiresome day this has been.",
        lastSpeakerId: RAM.id,
        roster: ROSTER,
        repliesSoFar: 1,
    });
    assert.strictEqual(follow.speaker, null);
});

test("the chain stops at the limit no matter what", () => {
    const follow = G.chooseFollowUp({
        lastMessage: "Rem, answer me!",
        lastSpeakerId: RAM.id,
        roster: ROSTER,
        repliesSoFar: 2,
        settings: { maxRepliesPerTurn: 2 },
    });
    assert.strictEqual(follow.speaker, null);
    assert.strictEqual(follow.reason, "reached-the-limit");
});

// --- What each character is told ---

test("a character is told who else is in the room", () => {
    const instruction = G.buildRoomInstruction({ speaker: RAM, roster: ROSTER, userName: "Kash" });
    assert.ok(instruction.includes("Rem"));
    assert.ok(instruction.includes("Roswaal"));
    assert.ok(instruction.includes("Kash"));
});

test("a character is not introduced to themselves", () => {
    const instruction = G.buildRoomInstruction({ speaker: RAM, roster: ROSTER });
    // Only count the lines that introduce a member, not the rules, which also happen
    // to be written as a bulleted list.
    const memberNames = ROSTER.map((c) => c.name);
    const introLines = instruction.split("\n").filter((line) =>
        memberNames.some((name) => line.startsWith(`- ${name}`))
    );
    assert.ok(!introLines.some((line) => line.startsWith("- Ram")), "Ram should not be introduced to herself");
    assert.strictEqual(introLines.length, 3, "the other three should each be introduced once");
});

test("a character is told firmly not to write everyone else's lines", () => {
    // Without this a model writes the whole scene including everybody's dialogue, and
    // the group collapses into one voice doing impressions.
    const instruction = G.buildRoomInstruction({ speaker: RAM, roster: ROSTER });
    assert.ok(/only as Ram/i.test(instruction));
    assert.ok(/never write dialogue for the others/i.test(instruction));
});

test("a group of one produces no room instruction", () => {
    assert.strictEqual(G.buildRoomInstruction({ speaker: RAM, roster: [RAM] }), "");
});

// --- Labelling the transcript ---

test("every line is labelled with who said it", () => {
    const messages = [youSaid("hello"), said(RAM.id, "hm"), said(REM.id, "hi!")];
    const labelled = G.labelHistoryForGroup(messages, ROSTER, "Kash");

    assert.strictEqual(labelled[0].name, "Kash");
    assert.strictEqual(labelled[1].name, "Ram");
    assert.strictEqual(labelled[2].name, "Rem");
});

test("the speaker's own lines are theirs, everyone else's are labelled", () => {
    const messages = [youSaid("hello"), said(RAM.id, "hm"), said(REM.id, "hi!")];
    const labelled = G.labelHistoryForGroup(messages, ROSTER, "Kash");
    const turns = G.buildHistoryForSpeaker(labelled, RAM.id);

    // Ram's own line comes back as her own voice, with no name in front of it.
    const ownTurn = turns.find((turn) => turn.role === "model");
    assert.ok(ownTurn);
    assert.ok(!ownTurn.content.startsWith("Ram:"), "a character should not narrate their own name");

    // Rem's line is presented to Ram as something someone else said.
    const heard = turns.filter((turn) => turn.role === "user").map((t) => t.content).join(" ");
    assert.ok(heard.includes("Rem: hi!"));
    assert.ok(heard.includes("Kash: hello"));
});

test("consecutive turns on the same side are merged", () => {
    // These APIs reject two user turns in a row, so this has to hold.
    const messages = [youSaid("one"), youSaid("two"), said(REM.id, "hi"), said(ROSWAAL.id, "hoo")];
    const labelled = G.labelHistoryForGroup(messages, ROSTER, "Kash");
    const turns = G.buildHistoryForSpeaker(labelled, RAM.id);

    for (let i = 1; i < turns.length; i += 1) {
        assert.notStrictEqual(turns[i].role, turns[i - 1].role, "no two turns in a row may share a role");
    }
});

test("system and deleted messages are left out", () => {
    const messages = [
        youSaid("hello"),
        { content: "New conversation started.", isSystem: true },
        { characterId: RAM.id, content: "gone", isDeleted: true },
        { characterId: REM.id, content: "typing", isTyping: true },
        said(REM.id, "here"),
    ];
    const labelled = G.labelHistoryForGroup(messages, ROSTER, "Kash");
    assert.strictEqual(labelled.length, 2);
});

test("a message from a character who has left the group is still readable", () => {
    const messages = [youSaid("hi"), said("someone-removed", "I was here once")];
    const labelled = G.labelHistoryForGroup(messages, ROSTER, "Kash");
    assert.strictEqual(labelled[1].name, "Someone");
});

// --- Odds and ends ---

test("an empty room chooses nobody rather than throwing", () => {
    const decision = G.chooseSpeakers({ message: "hello", roster: [], messages: [] });
    assert.strictEqual(decision.speakers.length, 0);
    assert.strictEqual(decision.reason, "nobody-here");
});

test("a group of one always answers", () => {
    const decision = G.chooseSpeakers({ message: "hello", roster: [RAM], messages: [] });
    assert.strictEqual(decision.speakers[0].id, RAM.id);
});

test("junk input does not throw", () => {
    [null, undefined, 42, {}, []].forEach((value) => {
        const decision = G.chooseSpeakers({ message: value, roster: ROSTER, messages: value });
        assert.ok(Array.isArray(decision.speakers));
    });
});

test("a suggested group name reads naturally", () => {
    assert.strictEqual(G.suggestGroupName([RAM, REM]), "Ram and Rem");
    assert.strictEqual(G.suggestGroupName([RAM, REM, SUBARU]), "Ram, Rem and Subaru");
    assert.strictEqual(G.suggestGroupName(ROSTER), "Ram, Rem and 2 others");
    assert.strictEqual(G.suggestGroupName([]), "New group");
});

test("the choice can be explained in words", () => {
    const decision = G.chooseSpeakers({ message: "Ram, hello", roster: ROSTER, messages: [] });
    const explanation = G.describeChoice(decision);
    assert.ok(explanation.includes("Ram"));
    assert.ok(explanation.length > 10);
});
