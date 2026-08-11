// Does the app actually start.
//
// Before the split there was no way to answer that without opening the page in a browser, which
// meant a typo in code that only runs at start up got found by whoever loaded the app next. These
// tests load every file the page loads, in the same order, into a stand in for a browser, and then
// start the app the way the browser does.
//
// It is not a browser. Nothing is laid out or drawn, so this says nothing about how the app looks.
// What it does prove is that every file parses, that they work together, that starting up runs to
// the end, and that no function the app relies on has gone missing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { bootApp, globalsDefined, globalKinds, ROOT } = require('../tools/loadapp');
const KEYS = require('../src/storage.js').KEYS;

const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixture-app-data.json'), 'utf8')
);

// The fixture, laid out the way the browser would have stored it.
function storedFixture() {
    const seed = {};
    seed[KEYS.CHARACTERS] = JSON.stringify(fixture.characters);
    seed[KEYS.CHATS] = JSON.stringify(fixture.chats);
    seed[KEYS.CHAT_HISTORY] = JSON.stringify(fixture.chatHistory);
    seed[KEYS.CHAT_MEMBERS] = JSON.stringify(fixture.chatMembers);
    seed[KEYS.LAST_ACTIVE_CHATS] = JSON.stringify(fixture.lastActiveChats);
    seed[KEYS.SETTINGS] = JSON.stringify(fixture.settings);
    seed[KEYS.PERSONAL_CONTEXT] = JSON.stringify(fixture.personalContext);
    return seed;
}

test('every file loads without error', async () => {
    const app = await bootApp();
    const broken = app.problems.map((p) => `${p.file}: ${p.error.message}`);
    assert.deepStrictEqual(broken, [], broken.join('\n'));
});

test('the app starts from nothing', async () => {
    // A first visit. Nothing stored, no key, no characters.
    const app = await bootApp();
    assert.deepStrictEqual(app.failures.map((e) => e.message), []);
    assert.deepStrictEqual(app.stepFailures, [], app.stepFailures.join('; '));
});

test('no start up step fails, with data or without', async () => {
    // Start up runs each step inside its own guard, so a broken one does not stop the others. That is
    // right for someone using the app and misleading in a test: nothing is thrown, so a step that
    // failed every single time still looked like a clean start. It did, for a while. The app records
    // what it caught, and that is what is checked here.
    const empty = await bootApp();
    assert.deepStrictEqual(empty.stepFailures, [],
        `steps failed on an empty start: ${empty.stepFailures.join('; ')}`);

    const full = await bootApp({ storage: storedFixture() });
    assert.deepStrictEqual(full.stepFailures, [],
        `steps failed with data loaded: ${full.stepFailures.join('; ')}`);

    // And nothing was written to the console as an error either.
    const errors = full.win.__logged.filter((line) => line.level === 'error');
    assert.deepStrictEqual(errors.map((line) => line.text.slice(0, 120)), []);
});

test('the app starts with a real amount of data', async () => {
    const app = await bootApp({ storage: storedFixture() });
    assert.deepStrictEqual(app.failures.map((e) => e.message), []);
    assert.deepStrictEqual(app.stepFailures, [], app.stepFailures.join('; '));

    const read = (expression) => vm.runInContext(expression, app.context);
    assert.strictEqual(read('state.characters.length'), fixture.characters.length);
    assert.strictEqual(
        read('Object.values(state.chats).reduce((n, c) => n + (c || []).length, 0)'),
        fixture.contents.messages
    );
    assert.strictEqual(read('state.personalContext.name'), 'Sam');
});

test('data that looks wrong is kept rather than deleted', async () => {
    // The rule the whole loader is built around: nothing is thrown away for looking wrong, because
    // the missing half may come back from a backup and a delete cannot be undone.
    const app = await bootApp({ storage: storedFixture() });
    const read = (expression) => vm.runInContext(expression, app.context);

    // A history entry whose chat body is missing. Hidden from the list, still in the data.
    assert.strictEqual(read('state.orphanedChats.length'), 1,
        'the history entry with no chat body should have been set aside');
    assert.ok(!read('JSON.stringify(state.usableChatHistory).includes("chat_bodyless001")'),
        'and it should not be offered as something you can open');
    assert.ok(read('JSON.stringify(state.chatHistory).includes("chat_bodyless001")'),
        'but it must still be in the stored history, not removed');

    // A chat belonging to a character who no longer exists. Also kept.
    assert.ok(read('Object.keys(state.chats).includes("chat_orphaned000")'),
        'the chat of a deleted character should still be there');
});

test('damaged data does not stop the app starting', async () => {
    // Every one of these has been seen in real storage at some point. None may be fatal.
    const damaged = {
        [KEYS.CHARACTERS]: '{not json at all',
        [KEYS.CHATS]: 'null',
        [KEYS.CHAT_HISTORY]: '[]',
        [KEYS.SETTINGS]: '"a string where an object should be"',
        [KEYS.PERSONAL_CONTEXT]: '',
        [KEYS.CHAT_MEMBERS]: '12345',
    };
    const app = await bootApp({ storage: damaged });
    assert.deepStrictEqual(app.failures.map((e) => e.message), []);
    assert.deepStrictEqual(app.stepFailures, [], app.stepFailures.join('; '));

    const read = (expression) => vm.runInContext(expression, app.context);
    assert.ok(Array.isArray(read('state.characters')), 'characters should still be a list');
    assert.strictEqual(read('typeof state.chats'), 'object');
});

test('nothing the app relies on has gone missing', async () => {
    // Splitting one file into many risks losing a function, or moving one into a scope where nothing
    // else can see it. The page would still load and one button would quietly do nothing. This
    // compares the whole list against a recorded one, so that cannot happen unnoticed.
    const recorded = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'expected-globals.json'), 'utf8')
    );

    const app = await bootApp();
    const names = globalsDefined(app);
    const kinds = globalKinds(app, names);
    const actual = names.map((name) => `${name}: ${kinds[name]}`);

    const lost = recorded.names.filter((entry) => !actual.includes(entry));
    const added = actual.filter((entry) => !recorded.names.includes(entry));

    assert.deepStrictEqual(lost, [],
        `these are gone or changed kind: ${lost.join(', ')}\n`
        + 'If that was deliberate, run: node tools/record-globals.js');
    assert.deepStrictEqual(added, [],
        `these are new: ${added.join(', ')}\n`
        + 'If that was deliberate, run: node tools/record-globals.js');
});

test('the functions the page calls by name are all there', async () => {
    // index.html calls these straight from an attribute on an element. If one stopped being a
    // function in the shared scope, the button would do nothing and nothing would say why.
    const calledFromMarkup = [
        'changeView', 'clearChatMessages', 'dismissBackupReminder',
        'exportAppData', 'saveApiKey', 'savePersonalContext', 'clearSidebarSearch',
    ];

    const app = await bootApp();
    const missing = calledFromMarkup.filter(
        (name) => vm.runInContext(`typeof ${name}`, app.context) !== 'function'
    );
    assert.deepStrictEqual(missing, [], `called from the page but not defined: ${missing}`);

    // And they really are still called from markup somewhere, so this list cannot rot into a list of
    // names nothing uses. Markup comes from index.html and from the app files that build HTML.
    const markup = [path.join(ROOT, 'index.html')]
        .concat(app.files.map((file) => path.join(ROOT, file)))
        .map((file) => fs.readFileSync(file, 'utf8'))
        .join('\n');
    const unused = calledFromMarkup.filter((name) => !markup.includes(`"${name}(`));
    assert.deepStrictEqual(unused, [],
        `no longer called from any markup, so remove them from this list: ${unused}`);
});

test('nothing is wired up twice', async () => {
    // Every listener in the app is meant to be attached once, from one place. The same function
    // attached twice to the same event on the same element means one click does the work twice, and
    // that is not visible by reading either of the two places it was attached from.
    //
    // It had happened: the create character button was wired in both setupEventListeners and
    // setupDirectListeners, so creating a character showed "created successfully" and "please provide
    // a name" together, which reads like the save failed when it had worked.
    const app = await bootApp({ storage: storedFixture() });

    const doubled = [];
    app.win.document.__byId.forEach((element, id) => {
        Object.keys(element.__listeners).forEach((type) => {
            const handlers = element.__listeners[type];
            const unique = new Set(handlers);
            if (unique.size !== handlers.length) {
                doubled.push(`${id} has the same ${type} handler attached ${handlers.length} times`);
            }
        });
    });

    assert.deepStrictEqual(doubled, [], doubled.join('; '));
});

test('creating a character says it worked, and says it once', async () => {
    // The visible half of the same fault. Worth checking on its own, because the wiring could be
    // right and the messages still wrong.
    const app = await bootApp();
    const run = (expression) => vm.runInContext(`(${expression})`, app.context);
    const document = app.win.document;

    document.getElementById('character-name').value = 'Someone New';
    document.getElementById('character-context').value = 'Enough of a description to be accepted.';
    document.getElementById('create-character-btn').__fire('click');

    assert.strictEqual(run('state.characters.length'), 1, 'one click should make one character');

    // Values are brought across as JSON. An array made inside the app is not the same kind of array
    // as one made out here, so comparing the two directly fails even when the contents match.
    const notices = JSON.parse(run('JSON.stringify(toastQueue.map((t) => t.kind))'));
    const detail = run('JSON.stringify(toastQueue.map((t) => t.kind + ": " + t.message))');
    assert.deepStrictEqual(notices, ['success'], `expected one success notice, got: ${detail}`);
});

test('an element the page does not have comes back as null', async () => {
    // The stand in used to hand back an element for any id asked for. That made every `if (element)`
    // check in the app true, so it took branches a browser never would, and one of them then failed
    // on an element with no parent. The failure looked like a bug in the app and was a bug in the
    // harness. This is here so it cannot come back.
    const app = await bootApp();
    const document = app.win.document;

    assert.strictEqual(document.getElementById('no-such-element-anywhere'), null);
    assert.strictEqual(document.getElementById('sidebar-char-madeup'), null);

    // Something the page really does have is there, and is attached, so swapping it works.
    const real = document.getElementById('message-input');
    assert.ok(real, 'message-input is in index.html and should be found');
    assert.ok(real.parentNode, 'a found element must have a parent, or replaceChild fails');

    // An element the app builds and names becomes findable, the way it would once added to the page.
    const made = document.createElement('div');
    made.id = 'built-by-the-app';
    assert.strictEqual(document.getElementById('built-by-the-app'), made);
});
