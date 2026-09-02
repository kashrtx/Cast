// What happens when you do something else while a reply is still coming.
//
// A reply takes seconds, and a person does not sit still for seconds. They open another character,
// they go to Settings and change provider, they start a second conversation with the same character.
// Every one of those is ordinary use and every one of them used to be able to put text in the wrong
// place, because the code that finished a reply looked at what was on screen at that moment rather
// than at what the reply had been asked for.
//
// The model is never called here. callAIChat and callAIText are replaced with something this file
// controls, so a reply can be held open, and other things done, and then let go. That is the only way
// to test a race deliberately rather than hope one shows up.

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { bootApp } = require('../tools/loadapp');
const KEYS = require('../src/storage.js').KEYS;

// Every app started by this file, so the timers can all be let go of at the end. Fast timers are real
// timers: without this the run finishes, every test passes, and the process sits there holding the
// event loop open, which looks exactly like a hang.
const started = [];

after(() => {
    started.forEach((win) => {
        if (typeof win.__clearAllTimers === 'function') win.__clearAllTimers();
    });
});

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixture-app-data.json'), 'utf8')
);

function storedFixture() {
    return {
        [KEYS.CHARACTERS]: JSON.stringify(fixture.characters),
        [KEYS.CHATS]: JSON.stringify(fixture.chats),
        [KEYS.CHAT_MEMBERS]: JSON.stringify(fixture.chatMembers),
        [KEYS.LAST_ACTIVE_CHATS]: JSON.stringify(fixture.lastActiveChats),
        // An OpenAI compatible provider on purpose. That path asks for its reply through callAIChat,
        // which this file can replace. Gemini streams through a client object built from a module
        // fetched over the network, which cannot be reached here. What is being tested is the app's
        // own bookkeeping around a reply, which is the same either way.
        [KEYS.SETTINGS]: JSON.stringify({
            ...fixture.settings,
            provider: 'openrouter',
            apiKeys: { openrouter: 'test-key' },
            models: { openrouter: 'some/model' },
        }),
        [KEYS.PERSONAL_CONTEXT]: JSON.stringify(fixture.personalContext),
    };
}

// Starts the app with a model that answers when this side says so.
//
// The provider is reported as connected so nothing tries to reach the network, and the two call
// paths hand back a promise that the test resolves by hand.
async function withControlledModel() {
    const app = await bootApp({ storage: storedFixture(), timers: 'fast' });
    started.push(app.win);
    assert.deepStrictEqual(app.stepFailures, [], app.stepFailures.join('; '));

    const run = (expression) => vm.runInContext(expression, app.context);
    const read = (expression) => JSON.parse(run(`JSON.stringify(${expression})`));

    // Pretend the provider is ready, so nothing attempts to connect.
    run('state.isApiConnected = true; state.activeProvider = getCurrentProvider();');

    // A queue of replies this side controls, exposed inside the app's own scope.
    run(`
        globalThis.__replies = [];
        globalThis.__nextReply = function (label) {
            let settle;
            const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
            globalThis.__replies.push({ label, settle, promise });
            return promise;
        };
        callAIChat = function () { return globalThis.__nextReply('chat'); };
        callAIText = function () { return globalThis.__nextReply('text'); };
    `);

    const pending = () => run('globalThis.__replies.length');
    const answer = (text, index = 0) => run(
        `globalThis.__replies[${index}].settle.resolve(${JSON.stringify(text)})`
    );
    const fail = (message, index = 0) => run(
        `globalThis.__replies[${index}].settle.reject(new Error(${JSON.stringify(message)}))`
    );

    // Lets queued promise callbacks run.
    // Lets the app's queued work run. The reply path waits before asking the model and again after,
    // so a few real turns of the event loop are needed rather than just draining microtasks.
    const settle = async () => {
        for (let round = 0; round < 8; round += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    };

    // Two chats with different characters, which is the situation that matters.
    const chats = read('Object.keys(state.chats).filter((id) => (state.chatMembers[id] || []).length === 1)');
    const firstChat = chats[0];
    const secondChat = chats.find((id) => {
        const members = read(`state.chatMembers[${JSON.stringify(id)}]`);
        const firstMembers = read(`state.chatMembers[${JSON.stringify(firstChat)}]`);
        return members[0] !== firstMembers[0];
    });
    assert.ok(secondChat, 'the fixture should have two chats with different characters');

    const openChat = (chatId) => run(`
        state.activeChat = ${JSON.stringify(chatId)};
        state.activeCharacters = getChatCharacters(${JSON.stringify(chatId)});
    `);

    const messagesIn = (chatId) => read(
        `(state.chats[${JSON.stringify(chatId)}] || []).map((m) => ({`
        + ' id: m.id, content: m.content, isUser: !!m.isUser, isTyping: !!m.isTyping,'
        + ' isDeleted: !!m.isDeleted, characterId: m.characterId || null }))'
    );

    // Fast timers are real timers, and the status updates repeat, so they keep the process alive after
    // the test has finished. Each test stops them when it is done.
    const stop = () => {
        // Nothing new may be scheduled first. Clearing on its own is not enough, because a timer
        // that is already due can run during the clearing and schedule another one.
        app.win.setTimeout = () => 0;
        app.win.setInterval = () => 0;
        app.win.requestAnimationFrame = () => 0;
        if (typeof app.win.__clearAllTimers === 'function') app.win.__clearAllTimers();
    };

    return {
        app, run, read, pending, answer, fail, settle, stop,
        firstChat, secondChat, openChat, messagesIn,
    };
}

test('a reply lands in the chat it was asked for, not the one on screen', async (t) => {
    // The fault. Ask a question, switch to another character while the reply is still coming, and the
    // reply arrived in the conversation you had switched to. It was in the wrong character's history
    // from then on, and it was sent to that character as context on the next turn.
    const c = await withControlledModel();
    t.after(c.stop);

    c.openChat(c.firstChat);
    const beforeFirst = c.messagesIn(c.firstChat).length;
    const beforeSecond = c.messagesIn(c.secondChat).length;

    c.run(`
        document.getElementById('message-input').value = 'a question in the first chat';
        globalThis.__sending = sendMessage();
    `);
    await c.settle();
    assert.ok(c.pending() > 0, 'the model should have been asked something');

    // Off to the other conversation while it is still thinking.
    c.openChat(c.secondChat);
    await c.settle();

    c.answer('the reply that belongs to the first chat');
    await c.settle();

    const first = c.messagesIn(c.firstChat);
    const second = c.messagesIn(c.secondChat);

    const leaked = second.filter((m) => String(m.content).includes('belongs to the first chat'));
    assert.deepStrictEqual(leaked, [],
        'the reply appeared in the chat that was on screen rather than the one it was for');

    assert.ok(
        first.some((m) => String(m.content).includes('belongs to the first chat')),
        'the reply should have gone into the chat it was asked for'
    );

    assert.strictEqual(c.messagesIn(c.secondChat).length, beforeSecond,
        'the other chat should be untouched');
    assert.ok(first.length > beforeFirst);
});

test('the question you asked never appears in another chat either', async (t) => {
    const c = await withControlledModel();
    t.after(c.stop);

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'my own words';
        globalThis.__sending = sendMessage();
    `);
    await c.settle();

    c.openChat(c.secondChat);
    await c.settle();
    c.answer('a reply');
    await c.settle();

    const second = c.messagesIn(c.secondChat);
    assert.deepStrictEqual(second.filter((m) => String(m.content).includes('my own words')), []);
});

test('a failure is reported in the chat that failed, not the one on screen', async () => {
    // The reply that says a character could not answer was put into whatever chat was open when the
    // failure came back, so the wrong character apologised for something they were never asked.
    const c = await withControlledModel();

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'a question that will fail';
        globalThis.__sending = sendMessage();
    `);
    await c.settle();

    c.openChat(c.secondChat);
    await c.settle();
    c.fail('the provider refused the request');
    await c.settle();

    const second = c.messagesIn(c.secondChat);
    const first = c.messagesIn(c.firstChat);
    const strays = second.filter((m) => !m.isUser && m.characterId
        && !read2(c, m.characterId, c.secondChat));

    assert.deepStrictEqual(strays, [],
        'a message from a character who is not in this chat appeared in it');
    assert.ok(first.some((m) => m.characterId && /unavailable right now/i.test(String(m.content))),
        'the originating chat should contain a durable explanation of the failure');
    assert.ok(!second.some((m) => /unavailable right now/i.test(String(m.content))),
        'the chat opened later must not receive the failure explanation');
});

// Whether a character belongs to a chat, asked of the app itself.
function read2(c, characterId, chatId) {
    return c.read(`chatBelongsToCharacter(${JSON.stringify(chatId)}, ${JSON.stringify(characterId)})`);
}

test('no typing indicator is left behind in a chat you switched away from', async () => {
    // A typing indicator that never goes away is the most reported symptom of all of this: the chat
    // looks like it is still thinking and there is no way to make it stop.
    const c = await withControlledModel();

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'a question';
        globalThis.__sending = sendMessage();
    `);
    await c.settle();

    c.openChat(c.secondChat);
    await c.settle();
    c.answer('a reply');
    await c.settle();

    [c.firstChat, c.secondChat].forEach((chatId) => {
        const stuck = c.messagesIn(chatId).filter((m) => m.isTyping && !m.isDeleted);
        assert.deepStrictEqual(stuck, [], `a typing indicator was left in ${chatId}`);
    });
});

test('changing provider while a reply is coming does not break the app', async () => {
    // Going to Settings and picking another provider clears the connection, which is right. What must
    // not happen is that the reply already on its way is lost, or that the app is left in a state
    // where the next message cannot be sent.
    const c = await withControlledModel();

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'a question before switching';
        globalThis.__sending = sendMessage();
    `);
    await c.settle();

    // The switch, exactly as the settings screen does it.
    c.run(`
        appSettings.provider = 'openrouter';
        appSettings.apiKeys.openrouter = 'another-key';
        appSettings.models.openrouter = 'some/model';
        markProviderConnectionDirty();
    `);
    await c.settle();

    c.answer('the reply from the provider that was in use at the time');
    await c.settle();

    // The reply is not thrown away. It was a real answer from a real request.
    const first = c.messagesIn(c.firstChat);
    assert.ok(
        first.some((m) => String(m.content).includes('was in use at the time')),
        'a reply that had already been asked for should still be delivered'
    );

    // And the app is usable afterwards.
    assert.strictEqual(c.read('state.isResponseInProgress'), false,
        'the app is stuck and will not send another message');
    const stuck = first.filter((m) => m.isTyping && !m.isDeleted);
    assert.deepStrictEqual(stuck, [], 'a typing indicator was left behind');
});

test('a second message cannot be sent while a reply is still coming', async (t) => {
    // This is not a leak, it is a lock, and it is worth a test of its own because a test written to
    // check for a leak here passed while checking nothing: the second message was refused, so there
    // was never anything to leak.
    //
    // Only one reply is in flight at a time, across the whole app. That is what stops two
    // conversations writing over each other. It also means you cannot talk to a second character
    // while the first is still answering, which is a limitation rather than a bug, and is written
    // down here so that a change to it is a decision rather than an accident.
    const c = await withControlledModel();
    t.after(c.stop);

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'the first question';
        globalThis.__a = sendMessage();
    `);
    await c.settle();

    assert.strictEqual(c.pending(), 1, 'the first message should have been sent');
    assert.strictEqual(c.read('state.isResponseInProgress'), true, 'the lock should be held');

    const beforeSecond = c.messagesIn(c.secondChat).length;
    c.openChat(c.secondChat);
    c.run(`
        document.getElementById('message-input').value = 'the second question';
        globalThis.__b = sendMessage();
    `);
    await c.settle();

    assert.strictEqual(c.pending(), 1, 'a second request should not have been made');
    assert.strictEqual(c.messagesIn(c.secondChat).length, beforeSecond,
        'the second question should not have been added to the chat either');

    // And once the first finishes, the lock is released.
    c.answer('the first answer');
    await c.settle();
    assert.strictEqual(c.read('state.isResponseInProgress'), false,
        'the lock was not released, so nothing can be sent ever again');
});

test('a reply that fails leaves no typing indicator behind, even in a chat you left', async (t) => {
    // The one that was actually wrong. A failure was handled by reporting it and returning, rather
    // than by throwing, so the tidying up in the outer catch never ran and the indicator stayed. If
    // you had moved to another character you would not see it happen, and going back showed that
    // conversation still apparently writing, with nothing short of a reload to clear it.
    const c = await withControlledModel();
    t.after(c.stop);

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'a question that will fail';
        globalThis.__a = sendMessage();
    `);
    await c.settle();
    assert.strictEqual(c.pending(), 1);

    // Away to another character, then the failure arrives.
    c.openChat(c.secondChat);
    await c.settle();
    c.fail('the provider refused the request');
    await c.settle();

    const stuck = c.messagesIn(c.firstChat).filter((m) => m.isTyping && !m.isDeleted);
    assert.deepStrictEqual(stuck, [],
        'the chat that was left behind still looks like it is writing');

    assert.strictEqual(c.read('state.isResponseInProgress'), false,
        'the app is locked and cannot send anything else');
});

test('an indicator left by something nobody has found is swept up on opening a chat', async (t) => {
    // The backstop. A reload in the middle of a reply, or a tab the phone suspended and woke later,
    // leaves an indicator in stored data with nothing behind it. Opening the chat clears it.
    const c = await withControlledModel();
    t.after(c.stop);

    const planted = c.run(`(function () {
        state.chats[${JSON.stringify('PLACEHOLDER')}];
        const chatId = ${JSON.stringify('PLACEHOLDER')};
        return 0;
    })()`);
    assert.strictEqual(planted, 0);

    // Plant one directly, the way a reload would leave it.
    c.run(`
        state.chats[${JSON.stringify('__chat_for_sweep__')}] = [
            { id: 'left-behind', content: '', isUser: false, isTyping: true, isDeleted: false,
              characterId: state.characters[0].id, timestamp: new Date().toISOString() },
        ];
    `);
    assert.strictEqual(
        c.read("state.chats['__chat_for_sweep__'].filter((m) => m.isTyping).length"), 1,
        'the indicator was not planted, so this test would check nothing'
    );

    c.run('clearStuckTypingIndicators()');

    assert.strictEqual(
        c.read("state.chats['__chat_for_sweep__'].filter((m) => m.isTyping).length"), 0,
        'the sweep did not clear it'
    );
});

test('the sweep leaves alone a chat that really is still writing', async (t) => {
    const c = await withControlledModel();
    t.after(c.stop);

    c.openChat(c.firstChat);
    c.run(`
        document.getElementById('message-input').value = 'a question';
        globalThis.__a = sendMessage();
    `);
    await c.settle();

    const before = c.messagesIn(c.firstChat).filter((m) => m.isTyping).length;
    assert.strictEqual(before, 1, 'there should be an indicator while a reply is coming');

    c.run('clearStuckTypingIndicators()');

    assert.strictEqual(c.messagesIn(c.firstChat).filter((m) => m.isTyping).length, 1,
        'the sweep removed an indicator for a reply that is genuinely on its way');

    c.answer('a reply');
    await c.settle();
});
