// Giving up on a request that is never going to answer.
//
// There was no time limit anywhere in the chain: not in the app, not in the development server, not in
// the Netlify function. A provider that accepted the connection and then said nothing left the request
// open for as long as the browser was willing to hold it, which is effectively forever. The app showed
// "Connecting to NVIDIA NIM." and went on showing it. No error, no timeout, nothing to click, and no
// way to tell a slow model from a dead one.
//
// A failure is more useful than that, because a failure says something. These check that one arrives.

const test = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');

const { bootApp } = require('../tools/loadapp');

// Starts the app with a fetch that behaves however the test needs.
async function withFetch(behaviour, settings = {}) {
    // Real timers, not collapsed ones. The wait is the thing being tested, so shortening it would
    // shorten the test out of existence.
    const app = await bootApp({ timers: 'real' });
    const run = (expression) => vm.runInContext(expression, app.context);
    const read = (expression) => JSON.parse(run(`JSON.stringify(${expression})`));

    run(`
        appSettings.provider = 'nvidia';
        appSettings.apiKeys.nvidia = 'nvapi-test';
        appSettings.models.nvidia = 'nvidia/some-very-large-model';
        appSettings.proxyUrl = 'http://127.0.0.1:3000/api/proxy';
        appSettings.requestTimeoutSeconds = ${Number(settings.requestTimeoutSeconds) || 1};
    `);

    app.win.fetch = behaviour;

    const stop = () => {
        if (typeof app.win.__clearAllTimers === 'function') app.win.__clearAllTimers();
    };

    return { app, run, read, stop };
}

// A fetch that never answers but does respect being told to stop, which is what a provider that has
// gone quiet looks like.
function silent() {
    return (url, init) => new Promise((resolve, reject) => {
        if (init && init.signal) {
            init.signal.addEventListener('abort', () => {
                const error = new Error('This operation was aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }
    });
}

test('a request that is never answered is given up on', async (t) => {
    const c = await withFetch(silent(), { requestTimeoutSeconds: 1 });
    t.after(c.stop);

    const started = Date.now();
    const outcome = await new Promise((resolve) => {
        c.app.win.__done = resolve;
        vm.runInContext(`
            fetchProvider('https://integrate.api.nvidia.com/v1/chat/completions',
                { method: 'POST', headers: {} }, 'nvidia')
                .then((r) => __done({ ok: true, status: r.status }))
                .catch((e) => __done({ ok: false, message: e.message }));
        `, c.app.context);
    });
    const took = Date.now() - started;

    assert.strictEqual(outcome.ok, false, 'the request answered when it should not have');
    assert.ok(took < 10000, `it waited ${took}ms, so the limit is not being applied`);
    assert.ok(took >= 900, `it gave up after ${took}ms, which is sooner than it was told to`);
});

test('the message says what happened and what to try', async (t) => {
    const c = await withFetch(silent(), { requestTimeoutSeconds: 1 });
    t.after(c.stop);

    const outcome = await new Promise((resolve) => {
        c.app.win.__done = resolve;
        vm.runInContext(`
            fetchProvider('https://integrate.api.nvidia.com/v1/chat/completions',
                { method: 'POST', headers: {} }, 'nvidia')
                .then(() => __done({ message: 'it answered' }))
                .catch((e) => __done({ message: e.message }));
        `, c.app.context);
    });

    // Named, so you know which provider went quiet.
    assert.match(outcome.message, /NVIDIA NIM/);
    // Says it gave up rather than that something is broken.
    assert.match(outcome.message, /given up on|sent nothing back/);
    // And offers something to do about it.
    assert.match(outcome.message, /smaller|raise/);
    // Not a wall of text.
    assert.ok(outcome.message.length < 500, `the message is ${outcome.message.length} characters`);
});

test('a request that answers quickly is not interfered with', async (t) => {
    // The limit must not become a limit on how fast a reply may arrive.
    const answers = () => Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'fine' } }] }),
        text: () => Promise.resolve('{}'),
        headers: { get: () => null },
    });

    const c = await withFetch(answers, { requestTimeoutSeconds: 1 });
    t.after(c.stop);

    const outcome = await new Promise((resolve) => {
        c.app.win.__done = resolve;
        vm.runInContext(`
            fetchProvider('https://integrate.api.nvidia.com/v1/chat/completions',
                { method: 'POST', headers: {} }, 'nvidia')
                .then((r) => __done({ ok: true, status: r.status }))
                .catch((e) => __done({ ok: false, message: e.message }));
        `, c.app.context);
    });

    assert.strictEqual(outcome.ok, true, `a good request was rejected: ${outcome.message}`);
    assert.strictEqual(outcome.status, 200);
});

test('the wait is a setting, kept within sensible bounds', async (t) => {
    const c = await withFetch(silent());
    t.after(c.stop);

    const msFor = (value) => {
        c.run(`appSettings.requestTimeoutSeconds = ${JSON.stringify(value)};`);
        return c.read('getRequestTimeoutMs()');
    };

    assert.strictEqual(msFor(60), 60000, 'a sensible value should be used as given');

    // Nonsense falls back rather than becoming NaN, which would abort instantly and look like the
    // provider refused.
    [undefined, null, 0, -5, 'not a number', NaN].forEach((value) => {
        const ms = msFor(value);
        assert.ok(Number.isFinite(ms) && ms > 0, `${JSON.stringify(value)} produced ${ms}`);
    });

    // And an extreme value is brought back into range rather than trusted.
    assert.ok(msFor(999999) <= 600000, 'an enormous wait is the same as having none');
    assert.ok(msFor(0.001) >= 1000, 'a tiny wait would abort before anything could answer');
});

test('nothing waits forever any more, anywhere in the chain', async () => {
    // The three places a request passes through, checked together, because a limit in two of them and
    // not the third is the same as having none.
    const fs = require('node:fs');
    const path = require('node:path');
    const ROOT = path.join(__dirname, '..');

    const transport = fs.readFileSync(path.join(ROOT, 'src', 'app', 'ai', 'transport.js'), 'utf8');
    assert.match(transport, /AbortController/, 'the app can still wait forever');

    const rules = fs.readFileSync(path.join(ROOT, 'proxy-rules.js'), 'utf8');
    assert.match(rules, /AbortController/, 'the proxy can still wait forever');
    assert.match(rules, /DEFAULT_TIMEOUT_MS/, 'the proxy has no default limit');

    // Both proxies go through the shared forwarding, which is where the limit lives.
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const fn = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'ai-proxy.mjs'), 'utf8');
    assert.match(server, /forwardThrough/, 'the development server forwards without the limit');
    assert.match(fn, /forwardThrough/, 'the Netlify function forwards without the limit');
});
