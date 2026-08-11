// The proxy, tested without a provider key or an internet connection.
//
// The proxy is the reason NVIDIA NIM and anything else that refuses browser requests can be used at
// all, and until now the only way to find out whether it worked was to deploy the site and try. There
// are two of them, the Netlify function and the development server, and they were two copies of the
// same logic, so a change to one could pass unnoticed in the other.
//
// The deciding is now in proxy-rules.js and is a plain function over a method, some headers and an
// address, which is testable directly. The development server is started on a real port and asked
// real questions, with a stand in provider on another port, so the whole path is exercised: browser to
// proxy to provider and back.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');

const rules = require('../proxy-rules.js');

const ROOT = path.join(__dirname, '..');

// --- The rules themselves --------------------------------------------------------------------

test('a preflight is answered, or the real request is never sent', () => {
    // The browser asks permission before sending anything with an Authorization header. No answer
    // means no request, reported as a network error with no status, which looks like the app is
    // broken.
    const plan = rules.planRequest({ method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });

    assert.strictEqual(plan.action, 'preflight');
    assert.strictEqual(plan.status, 204);
    assert.strictEqual(plan.headers['Access-Control-Allow-Origin'], 'http://localhost:3000');
    assert.match(plan.headers['Access-Control-Allow-Headers'], /Authorization/);
    assert.match(plan.headers['Access-Control-Allow-Headers'], /X-Cast-Target/);
});

test('a request with no target is refused with something actionable', () => {
    const plan = rules.planRequest({ method: 'POST', headers: {} });

    assert.strictEqual(plan.action, 'refuse');
    assert.strictEqual(plan.status, 400);
    assert.match(JSON.parse(plan.body).error.message, /X-Cast-Target/);
});

test('the target may be given as a header or as a query parameter', () => {
    const viaHeader = rules.planRequest({
        method: 'POST',
        headers: { 'x-cast-target': 'https://integrate.api.nvidia.com/v1/chat/completions' },
    });
    assert.strictEqual(viaHeader.action, 'forward');

    const viaQuery = rules.planRequest({
        method: 'POST',
        headers: {},
        url: '/api/proxy?target=https%3A%2F%2Fintegrate.api.nvidia.com%2Fv1%2Fchat%2Fcompletions',
    });
    assert.strictEqual(viaQuery.action, 'forward');
    assert.strictEqual(viaQuery.hostname, 'integrate.api.nvidia.com');
});

test('this is not an open proxy', () => {
    // The whole reason it can be left running is that it forwards only to providers. Without this it
    // is a relay anyone who finds it can use.
    const elsewhere = rules.planRequest({
        method: 'POST',
        headers: { 'x-cast-target': 'https://example.com/anything' },
    });

    assert.strictEqual(elsewhere.action, 'refuse');
    assert.strictEqual(elsewhere.status, 403);
    assert.match(JSON.parse(elsewhere.body).error.message, /not on this proxy's list/);
});

test('plain http and nonsense addresses are refused', () => {
    ['http://integrate.api.nvidia.com/v1', 'not a url at all', 'ftp://somewhere/x'].forEach((target) => {
        const plan = rules.planRequest({ method: 'POST', headers: { 'x-cast-target': target } });
        assert.strictEqual(plan.action, 'refuse', `${target} should have been refused`);
        assert.strictEqual(plan.status, 400);
    });
});

test('the key is carried through, and nothing about the browser is', () => {
    const plan = rules.planRequest({
        method: 'POST',
        headers: {
            'x-cast-target': 'https://integrate.api.nvidia.com/v1/chat/completions',
            authorization: 'Bearer sk-a-key',
            'content-type': 'application/json',
            'x-title': 'Cast',
            // Things a browser sets about itself, which some providers reject.
            origin: 'http://localhost:3000',
            referer: 'http://localhost:3000/index.html',
            'user-agent': 'Mozilla/5.0',
            cookie: 'session=private',
        },
    });

    assert.strictEqual(plan.action, 'forward');
    assert.strictEqual(plan.headers.authorization, 'Bearer sk-a-key');
    assert.strictEqual(plan.headers['x-title'], 'Cast');
    assert.strictEqual(plan.headers['content-type'], 'application/json');

    ['origin', 'referer', 'user-agent', 'cookie'].forEach((name) => {
        assert.ok(!(name in plan.headers), `${name} should not be forwarded to the provider`);
    });
});

test('headers work whether they arrive as an object or as a Headers', () => {
    // Node's http module gives a plain object. Netlify gives a Headers. The same function has to
    // read both, or one of the two proxies quietly forwards no key at all.
    const asHeaders = new Headers();
    asHeaders.set('x-cast-target', 'https://api.groq.com/openai/v1/chat/completions');
    asHeaders.set('authorization', 'Bearer sk-from-headers');

    const plan = rules.planRequest({ method: 'POST', headers: asHeaders });
    assert.strictEqual(plan.action, 'forward');
    assert.strictEqual(plan.headers.authorization, 'Bearer sk-from-headers');
});

test('every provider the app can route through the proxy is allowed by it', () => {
    // The app decides which providers need a proxy. If one of those is missing from the host list,
    // the app sends the request and the proxy refuses it, which is a confusing way to fail.
    const providers = require('../src/providers.js');
    const missing = [];

    providers.PROVIDER_ORDER.forEach((id) => {
        const provider = providers.getProvider(id);
        if (!provider) return;

        // Only the ones that will actually be sent through it. A local provider could not be reached
        // by a proxy anyway, and one that works direct never gets there.
        const routed = provider.cors === 'proxy' || providers.alwaysNeedsProxy(id);
        if (!routed) return;

        const baseUrl = provider.baseUrl || '';
        if (!baseUrl) return;

        try {
            const host = new URL(baseUrl).hostname;
            if (!rules.ALLOWED_HOSTS.has(host)) missing.push(`${id} (${host})`);
        } catch (error) {
            missing.push(`${id} has an unreadable default address: ${baseUrl}`);
        }
    });

    assert.ok(providers.PROVIDER_ORDER.length > 5, 'the provider list looks empty, so this checked nothing');

    assert.deepStrictEqual(missing, [],
        `these need the proxy but the proxy will not forward to them: ${missing.join(', ')}`);
});

// --- The development server, on a real port --------------------------------------------------

// A stand in for a provider. It records what it was asked and answers like an OpenAI compatible
// service would.
function startFakeProvider() {
    const seen = [];
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                seen.push({
                    method: req.method,
                    url: req.url,
                    headers: req.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    choices: [{ message: { role: 'assistant', content: 'a reply from the provider' } }],
                }));
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
    });
}

// A provider that accepts the connection and then says nothing, which is the case nothing in the chain
// used to handle.
function startSilentProvider() {
    return new Promise((resolve) => {
        const server = http.createServer(() => {
            // Deliberately no response, ever.
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function startDevServer(port, extraEnv = {}) {
    return new Promise((resolve, reject) => {
        const child = fork(path.join(ROOT, 'server.js'), [], {
            env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let output = '';
        const onData = (data) => {
            output += String(data);
            if (output.includes('is running at')) resolve(child);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        setTimeout(() => reject(new Error(`the server did not start: ${output}`)), 5000);
    });
}

function request(port, options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

// A free port, found by opening one and letting it go.
function freePort() {
    return new Promise((resolve) => {
        const probe = http.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

test('the development server serves the app and answers on the proxy address', async (t) => {
    const port = await freePort();
    const child = await startDevServer(port);
    t.after(() => child.kill());

    const page = await request(port, { method: 'GET', path: '/' });
    assert.strictEqual(page.status, 200, 'the page itself should still be served');
    assert.match(page.body, /<title>/i);

    // The address the app works out for itself, with no configuration.
    const providers = require('../src/providers.js');
    const expected = providers.defaultProxyUrl(`http://127.0.0.1:${port}`, 'http:');
    assert.strictEqual(expected, `http://127.0.0.1:${port}/api/proxy`,
        'the app looks for the proxy here, so this is the address the server has to answer on');

    const preflight = await request(port, { method: 'OPTIONS', path: '/api/proxy' });
    assert.strictEqual(preflight.status, 204);
    assert.ok(preflight.headers['access-control-allow-origin'],
        'without this the browser never sends the real request');
});

test('the development server refuses to relay anywhere that is not a provider', async (t) => {
    const port = await freePort();
    const child = await startDevServer(port);
    t.after(() => child.kill());

    const answer = await request(port, {
        method: 'POST',
        path: '/api/proxy',
        headers: { 'x-cast-target': 'https://example.com/anything', 'content-type': 'application/json' },
    }, '{}');

    assert.strictEqual(answer.status, 403);
    assert.match(JSON.parse(answer.body).error.message, /not on this proxy's list/);
});

test('a request really does go browser to proxy to provider and back', async (t) => {
    // The test that used to be here claimed this and did not do it. The stand in provider was on plain
    // http, which the rules refuse, so it fell back to checking the planning and then called the stand
    // in directly, skipping the proxy entirely. The forwarding was never tested at all, which is
    // exactly the part that matters.
    //
    // It works now because a host you add yourself with CAST_PROXY_EXTRA_HOSTS may be plain http, which
    // is a real feature for anyone self hosting a model, and which makes this testable.
    const provider = await startFakeProvider();
    t.after(() => provider.server.close());

    const port = await freePort();
    const child = await startDevServer(port, { CAST_PROXY_EXTRA_HOSTS: '127.0.0.1' });
    t.after(() => child.kill());

    const target = `http://127.0.0.1:${provider.port}/v1/chat/completions`;
    const answer = await request(port, {
        method: 'POST',
        path: '/api/proxy',
        headers: {
            'content-type': 'application/json',
            'x-cast-target': target,
            authorization: 'Bearer sk-a-real-looking-key',
            // Things a browser sets about itself, which some providers reject.
            cookie: 'session=private',
            'user-agent': 'a browser',
        },
    }, JSON.stringify({ model: 'a-model', messages: [{ role: 'user', content: 'hello' }] }));

    assert.strictEqual(answer.status, 200, `the proxy did not forward: ${answer.body}`);
    const payload = JSON.parse(answer.body);
    assert.strictEqual(payload.choices[0].message.content, 'a reply from the provider');

    // The provider saw one request, with the key, and without the browser's own headers.
    assert.strictEqual(provider.seen.length, 1, 'the provider was not actually reached');
    assert.strictEqual(provider.seen[0].headers.authorization, 'Bearer sk-a-real-looking-key');
    assert.strictEqual(provider.seen[0].method, 'POST');
    assert.match(provider.seen[0].body, /hello/, 'the body did not arrive');
    assert.ok(!provider.seen[0].headers.cookie, 'a cookie was forwarded to the provider');

    // And the answer carries the headers the browser needs to be allowed to read it.
    assert.ok(answer.headers['access-control-allow-origin']);
});

test('a host you did not add is still refused, even with extra hosts set', async (t) => {
    // Adding one host must not open the proxy to everything.
    const port = await freePort();
    const child = await startDevServer(port, { CAST_PROXY_EXTRA_HOSTS: '127.0.0.1' });
    t.after(() => child.kill());

    const answer = await request(port, {
        method: 'POST',
        path: '/api/proxy',
        headers: { 'content-type': 'application/json', 'x-cast-target': 'https://example.com/x' },
    }, '{}');

    assert.strictEqual(answer.status, 403);
});

test('a provider that goes quiet is given up on rather than waited for forever', async (t) => {
    // The fault behind "no timeout or anything". There was no limit at any point in the chain, so a
    // provider that accepted the connection and then said nothing held the request open indefinitely
    // and the app showed "Connecting..." with nothing to click.
    const silent = await startSilentProvider();
    t.after(() => silent.server.close());

    const port = await freePort();
    const child = await startDevServer(port, {
        CAST_PROXY_EXTRA_HOSTS: '127.0.0.1',
        CAST_PROXY_TIMEOUT_MS: '600',
    });
    t.after(() => child.kill());

    const started = Date.now();
    const answer = await request(port, {
        method: 'POST',
        path: '/api/proxy',
        headers: {
            'content-type': 'application/json',
            'x-cast-target': `http://127.0.0.1:${silent.port}/v1/chat/completions`,
        },
    }, '{}');
    const took = Date.now() - started;

    assert.strictEqual(answer.status, 504, `expected to give up, got ${answer.status}: ${answer.body}`);
    assert.match(JSON.parse(answer.body).error.message, /sent nothing back/);
    assert.ok(took < 8000, `it waited ${took}ms, so the limit is not being applied`);
});

test('the forwarding gives up on its own, without a server', async () => {
    // The same limit, checked directly, so a change to it does not need a socket to notice.
    const plan = rules.planRequest({
        method: 'POST',
        headers: { 'x-cast-target': 'https://api.groq.com/openai/v1/chat/completions' },
    });
    assert.strictEqual(plan.action, 'forward');

    // A fetch that respects the abort signal and otherwise never answers, which is what a provider that
    // has gone quiet looks like.
    const neverAnswers = (url, init) => new Promise((resolve, reject) => {
        if (init && init.signal) {
            init.signal.addEventListener('abort', () => {
                const error = new Error('This operation was aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }
    });

    const started = Date.now();
    const outcome = await rules.forwardThrough(plan, { fetchImpl: neverAnswers, timeoutMs: 300 });
    const took = Date.now() - started;

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.refusal.status, 504);
    assert.match(JSON.parse(outcome.refusal.body).error.message, /given up on/);
    assert.ok(took < 4000, `waited ${took}ms`);
});

test('a provider that refuses the connection is reported as unreachable, not as a timeout', async () => {
    const plan = rules.planRequest({
        method: 'POST',
        headers: { 'x-cast-target': 'https://api.groq.com/openai/v1/chat/completions' },
    });

    const refused = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const outcome = await rules.forwardThrough(plan, { fetchImpl: refused, timeoutMs: 5000 });

    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.refusal.status, 502, 'a refused connection is not a timeout');
    assert.match(JSON.parse(outcome.refusal.body).error.message, /could not reach/);
});

test('the two proxies share their rules rather than each having a copy', () => {
    const fs = require('node:fs');
    const fn = fs.readFileSync(path.join(ROOT, 'netlify', 'functions', 'ai-proxy.mjs'), 'utf8');
    const dev = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

    assert.match(fn, /from '\.\.\/\.\.\/proxy-rules\.js'/,
        'the Netlify function should use the shared rules');
    assert.match(dev, /require\('\.\/proxy-rules'\)/,
        'the development server should use the shared rules');

    // Neither may keep its own host list, which is what drifted before.
    assert.ok(!fn.includes('integrate.api.nvidia.com'),
        'the Netlify function has its own copy of the host list again');
    assert.ok(!dev.includes('integrate.api.nvidia.com'),
        'the development server has its own copy of the host list');
});

// --- Opening the app straight off the disk ----------------------------------------------------

test('a page opened from a file is told plainly why a proxied provider cannot work', () => {
    // This is the failure behind "I cannot even test it because of CORS". A file:// page has no server
    // behind it, so there is no proxy and no way to make one. Every attempt came back as
    // "Failed to fetch" with no status, which reads like the app is broken rather than like the app
    // needs to be served.
    const providers = require('../src/providers.js');

    const message = providers.fileUrlProxyProblem('file:', 'nvidia');
    assert.ok(message, 'nothing was said at all, which is the original problem');
    assert.match(message, /npm start/, 'it has to say what to do, not just what is wrong');
    assert.match(message, /NVIDIA NIM/, 'and name the provider');
});

test('nothing is said when there is nothing wrong', () => {
    const providers = require('../src/providers.js');

    // Gemini accepts browser requests, so a file:// page is fine for it.
    assert.strictEqual(providers.fileUrlProxyProblem('file:', 'gemini'), '');
    // And served over http there is a proxy, so the situation does not arise.
    assert.strictEqual(providers.fileUrlProxyProblem('http:', 'nvidia'), '');
    assert.strictEqual(providers.fileUrlProxyProblem('https:', 'nvidia'), '');
});

test('the cors policy answers the same whether given a provider or its id', () => {
    // Handed a string it used to find no cors field and return "try-direct", the least cautious of the
    // three answers, so a provider that must be proxied would have been sent straight at the browser.
    // Every caller in the app happened to pass a provider, so nothing was broken, but a helper whose
    // wrong answer is the unsafe one should not depend on which shape it was given.
    const providers = require('../src/providers.js');

    providers.PROVIDER_ORDER.forEach((id) => {
        assert.strictEqual(providers.corsPolicy(id), providers.corsPolicy(providers.getProvider(id)),
            `corsPolicy disagrees with itself for ${id}`);
        assert.strictEqual(providers.alwaysNeedsProxy(id),
            providers.alwaysNeedsProxy(providers.getProvider(id)),
            `alwaysNeedsProxy disagrees with itself for ${id}`);
    });

    assert.strictEqual(providers.corsPolicy('nvidia'), 'proxy');
    assert.strictEqual(providers.alwaysNeedsProxy('nvidia'), true);
});
