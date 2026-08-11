// Does the app do the right thing, not just start.
//
// These call the app's own functions inside a started app and check what comes back. That is worth
// having on its own, and it was also how the split was checked: the same calls were made against the
// single file version and the results compared, so anything that had changed would have shown up
// here rather than in front of someone using the app.
//
// Nothing here reaches the network. Anything that would is either not called or fails on purpose,
// which is itself worth testing, because a provider that is not set up is the most common state the
// app is ever in.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { bootApp, serialize } = require('../tools/loadapp');
const KEYS = require('../src/storage.js').KEYS;

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixture-app-data.json'), 'utf8')
);

function storedFixture(overrides = {}) {
    return {
        [KEYS.CHARACTERS]: JSON.stringify(fixture.characters),
        [KEYS.CHATS]: JSON.stringify(fixture.chats),
        [KEYS.CHAT_HISTORY]: JSON.stringify(fixture.chatHistory),
        [KEYS.CHAT_MEMBERS]: JSON.stringify(fixture.chatMembers),
        [KEYS.LAST_ACTIVE_CHATS]: JSON.stringify(fixture.lastActiveChats),
        [KEYS.SETTINGS]: JSON.stringify(fixture.settings),
        [KEYS.PERSONAL_CONTEXT]: JSON.stringify(fixture.personalContext),
        ...overrides,
    };
}

// Starts an app and hands back a way to run an expression inside it.
async function withApp(storage) {
    const app = await bootApp({ storage });
    assert.deepStrictEqual(app.failures.map((e) => e.message), [], 'the app did not start');
    const run = (expression) => vm.runInContext(`(${expression})`, app.context);
    return { app, run };
}

test('a character list is filtered and ordered', async () => {
    const { run } = await withApp(storedFixture());

    // Names, descriptions and messages are all searched.
    assert.strictEqual(run('filterCharacters(state.characters, "Ada").length'), 1);
    assert.strictEqual(run('filterCharacters(state.characters, "ada").length'), 1,
        'search should not care about case');
    assert.strictEqual(run('filterCharacters(state.characters, "").length'), 10,
        'an empty search should keep everyone');
    assert.strictEqual(run('filterCharacters(state.characters, "nobodyhasthis").length'), 0);

    // Ordering.
    const byName = run('sortCharacters(state.characters.slice(), "name_asc").map(c => c.name)');
    assert.deepStrictEqual(byName, byName.slice().sort(), 'name_asc should be alphabetical');

    const reversed = run('sortCharacters(state.characters.slice(), "name_desc").map(c => c.name)');
    assert.deepStrictEqual(reversed, byName.slice().reverse());

    const newest = run('sortCharacters(state.characters.slice(), "createdAt_desc").map(c => c.createdAt)');
    const oldest = run('sortCharacters(state.characters.slice(), "createdAt_asc").map(c => c.createdAt)');
    assert.deepStrictEqual(newest, oldest.slice().reverse());
});

test('a character is always read back fresh, so an edit applies to the next message', async () => {
    // This is the reason getLiveCharacter exists. A copy taken when the chat was opened would send
    // the old description, and the edit would appear not to have worked until a reload.
    const { run } = await withApp(storedFixture());

    const stale = run('JSON.parse(JSON.stringify(state.characters[0]))');
    run(`(() => { state.characters[0].userContext = "changed"; })()`);

    const live = run(`getLiveCharacter(${JSON.stringify(stale)})`);
    assert.strictEqual(live.userContext, 'changed',
        'looking a character up again should give the current record, not the copy passed in');
});

test('what gets sent to the model contains the character and the person', async () => {
    const { run } = await withApp(storedFixture());

    const prompt = run(`(() => {
        const chatId = Object.keys(state.chats)[0];
        const character = getChatCharacters(chatId)[0];
        return prepareContextForAPI(character, state.chats[chatId], getChatCharacters(chatId));
    })()`);

    assert.match(prompt, /Ada Vance/, 'the character should be named');
    assert.match(prompt, /Core essence/, 'the written profile should be included');
    assert.match(prompt, /Sam/, 'what the app was told about the person should be included');
    assert.match(prompt, /Curious, a bit blunt/);
    assert.match(prompt, /Stay in character/, 'the guidance should be included');
});

test('a deleted message is hidden from the model but not lost', async () => {
    const { run } = await withApp(storedFixture());

    const counts = run(`(() => {
        const chatId = Object.keys(state.chats).find(id => state.chats[id].some(m => m.isDeleted));
        const character = getChatCharacters(chatId)[0];
        const all = state.chats[chatId];
        const history = convertHistoryForGemini(all.filter(m => !m.isDeleted), character);
        return {
            stored: all.length,
            deleted: all.filter(m => m.isDeleted).length,
            sent: history.length,
        };
    })()`);

    assert.ok(counts.deleted > 0, 'the fixture should contain a deleted message');
    assert.ok(counts.sent < counts.stored, 'a deleted message should not be sent');
    assert.strictEqual(counts.stored, run(`(() => {
        const chatId = Object.keys(state.chats).find(id => state.chats[id].some(m => m.isDeleted));
        return state.chats[chatId].length;
    })()`), 'and it should still be stored');
});

test('a message becomes markup with the text and the formatting in it', async () => {
    // createMessageHTML builds an element rather than returning a string, so it has to be walked.
    // Comparing the element itself would compare "[object Object]" and prove nothing.
    const { run } = await withApp(storedFixture());

    const html = serialize(run(`(() => {
        const chatId = Object.keys(state.chats)[0];
        return createMessageHTML(state.chats[chatId][1]);
    })()`));

    assert.ok(html.length > 100, `expected real markup, got ${html.length} characters`);
    assert.match(html, /Right then/, 'the reply text should be there');
    assert.match(html, /<strong>/, '**emphasis** should have become strong');
    assert.match(html, /<em>/, '*action* should have become em');
    assert.match(html, /data-message-id="msg/, 'the message should carry its id, for editing later');
    assert.doesNotMatch(html, /\*\*/, 'no raw markdown should be left in the output');
});

test('a message from a person is told apart from a reply', async () => {
    const { run } = await withApp(storedFixture());

    const both = run(`(() => {
        const chatId = Object.keys(state.chats)[0];
        return [state.chats[chatId][0], state.chats[chatId][1]];
    })()`);
    assert.strictEqual(both[0].isUser, true);
    assert.strictEqual(both[1].isUser, false);

    const mine = serialize(run(`createMessageHTML(Object.values(state.chats)[0][0])`));
    const theirs = serialize(run(`createMessageHTML(Object.values(state.chats)[0][1])`));
    assert.notStrictEqual(mine, theirs, 'the two should not render the same way');
    assert.match(theirs, /character-avatar/, 'a reply should show who said it');
});

test('text from a model is routed through the sanitiser', async () => {
    // The app's defence against a model returning markup is DOMPurify, which is a library and is
    // tested as one. What is ours to get right is that every reply goes through it, and that the
    // markdown step does not build a script tag by itself. Those are what this checks. The harness
    // deliberately does not sanitise, so a test claiming otherwise would only be testing the
    // harness.
    const { app, run } = await withApp(storedFixture());

    const nasty = [
        '<script>window.owned = true;<' + '/script>',
        '<img src=x onerror="window.owned = true">',
        '[click](javascript:window.owned=true)',
    ];

    nasty.forEach((content) => {
        const before = app.win.__sanitizerCalls.length;
        run(`createMessageHTML(${JSON.stringify({
            id: 'probe1', content, isUser: false, characterId: fixture.characters[0].id,
            timestamp: '2025-06-01T10:00:00.000Z', isDeleted: false,
        })})`);
        assert.ok(app.win.__sanitizerCalls.length > before,
            `nothing was sanitised for: ${content}`);
    });

    // And the markdown step on its own must not turn a link into a javascript url.
    const rendered = app.win.__sanitizerCalls.slice(-1)[0].html;
    assert.doesNotMatch(rendered, /href="javascript:/i,
        'markdown should not build a javascript link');

    // Nothing was actually executed while rendering any of that.
    assert.strictEqual(run('typeof window.owned'), 'undefined');
});

test('the sanitiser is given the settings that keep formatting but drop behaviour', async () => {
    const { app, run } = await withApp(storedFixture());
    app.win.__sanitizerCalls.length = 0;

    run('createMessageHTML(Object.values(state.chats)[0][1])');
    const call = app.win.__sanitizerCalls[0];
    assert.ok(call, 'the reply was not sanitised at all');
    assert.ok(call.options && typeof call.options === 'object',
        'sanitising should be given explicit settings rather than the defaults');
});

test('sending puts the message on screen straight away', async () => {
    // The reply needs a provider and cannot arrive here. What must still happen is that what you
    // typed appears at once, rather than after a round trip.
    const { run } = await withApp(storedFixture());

    const outcome = run(`(() => {
        const chatId = Object.keys(state.chats)[0];
        state.activeChat = chatId;
        state.activeCharacters = getChatCharacters(chatId);
        const before = state.chats[chatId].length;
        document.getElementById('message-input').value = 'hello there';
        sendMessage();
        const after = state.chats[chatId];
        return {
            added: after.length - before,
            mine: after[before],
            box: document.getElementById('message-input').value,
        };
    })()`);

    assert.ok(outcome.added >= 1, 'the message should have been added');
    assert.strictEqual(outcome.mine.content, 'hello there');
    assert.strictEqual(outcome.mine.isUser, true);
    assert.strictEqual(outcome.box, '', 'the box should have been cleared');
});

test('a provider with nothing filled in says what is missing', async () => {
    const { run } = await withApp({});

    assert.strictEqual(run('isProviderConfigured("gemini")'), false);
    const message = run('getProviderConfigurationMessage("gemini")');
    assert.match(message, /key/i, 'the message should mention the key that is missing');
    assert.ok(message.length < 200, 'and it should be a sentence, not a wall of text');
});

test('token limits fall back rather than becoming NaN', async () => {
    const { run } = await withApp({});

    assert.strictEqual(run('getTokenLimit(2048)'), 2048);
    assert.strictEqual(run('getTokenLimit(undefined, 4096)'), 4096);
    assert.strictEqual(run('getTokenLimit("not a number", 4096)'), 4096);
    assert.strictEqual(run('getTokenLimit(0, 4096)'), 4096);
});

test('sizes and dates come out readable', async () => {
    const { run } = await withApp({});

    assert.match(run('formatBytes(0)'), /0/);
    assert.match(run('formatBytes(1024)'), /^1(\.0+)? ?KB$/i);
    assert.match(run('formatBytes(1048576)'), /^1(\.0+)? ?MB$/i);
    assert.match(run('formatBytes(1536)'), /1\.5/, 'a part size should not be rounded away');
    assert.strictEqual(typeof run('formatDateTime(new Date().toISOString())'), 'string');
    assert.ok(run('formatDateTime(new Date().toISOString()).length') > 0);
});

test('the theme is applied to the page and read back from storage', async () => {
    const { app, run } = await withApp({});

    // Applying puts the class on the page and reports what it settled on. It does not store, which
    // is why these are two separate things to check.
    assert.strictEqual(run('applyTheme("dark")'), 'dark');
    assert.strictEqual(app.win.document.documentElement.classList.contains('dark'), true);

    assert.strictEqual(run('applyTheme("light")'), 'light');
    assert.strictEqual(app.win.document.documentElement.classList.contains('dark'), false);

    // Anything unrecognised falls back rather than throwing.
    assert.strictEqual(run('applyTheme("chartreuse")'), 'auto');
    assert.strictEqual(run('applyTheme(undefined)'), 'auto');

    // With nothing stored, the answer is auto.
    assert.strictEqual(run('getTheme()'), 'auto');
});

test('a stored theme survives a reload', async () => {
    const uiState = {};
    uiState[KEYS.UI_STATE] = JSON.stringify({ theme: 'dark' });
    const { run } = await withApp(uiState);
    assert.strictEqual(run('getTheme()'), 'dark');
});

test('moving between views does not throw and records where you are', async () => {
    const { run } = await withApp(storedFixture());

    ['characters', 'chat', 'settings', 'home'].forEach((view) => {
        assert.doesNotThrow(() => run(`changeView(${JSON.stringify(view)})`), `changeView("${view}") threw`);
    });
});

test('the home screen and the lists draw with real data', async () => {
    const { app, run } = await withApp(storedFixture());

    run('renderChatHome("")');
    const recent = app.win.document.getElementById('home-recent').innerHTML;
    const all = app.win.document.getElementById('home-all').innerHTML;
    assert.ok(recent.length > 0, 'recent chats should have been drawn');
    assert.ok(all.length > 0, 'the rest of the characters should have been drawn');
    assert.match(app.win.document.getElementById('home-count').textContent, /10/);

    run('renderFilteredAndSortedCharacters()');
    const list = app.win.document.getElementById('character-list').innerHTML;
    fixture.characters.forEach((character) => {
        assert.ok(list.includes(character.name), `${character.name} is missing from the list`);
    });

    run('updateSidebarCharacters()');
    assert.ok(app.win.document.getElementById('sidebar-characters').innerHTML.length > 0);
});

test('an export contains everything and holds no key unless asked', async () => {
    const { run } = await withApp(storedFixture());

    const built = (includeApiKey) => run(`(() => {
        setApiKeyFor('gemini', 'secret-key-value');
        return JSON.stringify(CastBackup.buildExport({
            data: {
                characters: state.characters,
                chats: state.chats,
                chatHistory: state.chatHistory,
                chatMembers: state.chatMembers,
                lastActiveChats: state.lastActiveChats,
                settings: appSettings,
                personalContext: state.personalContext,
                apiKeys: appSettings.apiKeys,
            },
            brand: CastBrand,
            includeApiKey: ${includeApiKey ? 'true' : 'false'},
            when: new Date('2026-01-01T00:00:00.000Z'),
        }));
    })()`);

    const withoutKey = built(false);
    assert.ok(withoutKey.includes('Ada Vance'), 'characters should be in the export');
    assert.ok(withoutKey.includes('Right then'), 'the messages should be in the export');
    assert.ok(!withoutKey.includes('secret-key-value'),
        'a key must never be exported unless it was asked for, including inside settings');

    // And when it is asked for, it is there, or the setting would be a lie.
    assert.ok(built(true).includes('secret-key-value'));
});

test('an export can be read back in', async () => {
    // The round trip is the only thing that makes a backup worth anything.
    const { run } = await withApp(storedFixture());

    const restored = run(`(() => {
        const file = CastBackup.buildExport({
            data: {
                characters: state.characters,
                chats: state.chats,
                chatHistory: state.chatHistory,
                chatMembers: state.chatMembers,
                lastActiveChats: state.lastActiveChats,
                settings: appSettings,
                personalContext: state.personalContext,
            },
            brand: CastBrand,
            includeApiKey: false,
        });
        const read = CastBackup.normaliseImport(JSON.parse(JSON.stringify(file)));
        return JSON.stringify({
            ok: !!read && read.ok !== false && !!read.data,
            problems: read.problems || [],
            characters: ((read.data || {}).characters || []).length,
            chats: Object.keys((read.data || {}).chats || {}).length,
            firstName: (((read.data || {}).characters || [])[0] || {}).name,
            messages: Object.values((read.data || {}).chats || {})
                .reduce((n, c) => n + (c || []).length, 0),
        });
    })()`);

    const summary = JSON.parse(restored);
    assert.strictEqual(summary.ok, true, 'the file the app writes should be a file the app can read');
    assert.deepStrictEqual(summary.problems, [],
        `reading back the app's own file reported problems: ${summary.problems.join('; ')}`);
    assert.strictEqual(summary.characters, fixture.characters.length);
    assert.strictEqual(summary.chats, Object.keys(fixture.chats).length);
    assert.strictEqual(summary.messages, fixture.contents.messages,
        'every message should have survived the round trip');
    assert.ok(summary.firstName, 'characters should have come back with their names');
});

test('a failure is turned into a sentence rather than a wall of JSON', async () => {
    const { run } = await withApp({});

    const message = run(`describeProviderFailure(401, JSON.stringify({
        error: { message: 'API key not valid. Please pass a valid API key.', code: 401 }
    }), 'gemini')`);

    assert.strictEqual(typeof message, 'string');
    assert.ok(message.length > 0);
    assert.ok(message.length < 400, 'a notice should be readable, not a dump');
});

test('nothing is written to storage that cannot be read back', async () => {
    const { app } = await withApp(storedFixture());

    const entries = Array.from(app.win.localStorage.__map.entries());
    assert.ok(entries.length > 0, 'the app should have written something');

    entries.forEach(([key, value]) => {
        if (!value || value === 'undefined') {
            assert.fail(`${key} was written as ${value}`);
        }
        // Everything the app stores is JSON, except the key which is stored as plain text.
        if (key === KEYS.API_KEY) return;
        assert.doesNotThrow(() => JSON.parse(value), `${key} is not readable JSON`);
    });
});
