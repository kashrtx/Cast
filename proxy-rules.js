// The proxy, in one place.
//
// Some providers will not accept a request that comes straight from a web page. NVIDIA NIM is the
// well known one: it sends no CORS headers, so the browser refuses to send the request at all and
// reports "Failed to fetch" with no status. That reads like the app is broken when in fact nothing
// ever left the machine.
//
// A server has no such restriction, so the request goes through one. There are two of them: the
// Netlify function for a deployed site, and the local development server, which is the one that
// means you can test NVIDIA NIM, OpenRouter and the rest on your own machine without deploying
// anything. Both of them are this file with a different wrapper around it.
//
// It was two copies before, one in each. That is fine until the day someone adds a provider to one
// list and then cannot work out why it only fails locally.
//
// Your key travels from your browser to your own proxy and on to the provider. It is not stored, not
// logged, and not sent anywhere else. That is the reason to run your own rather than use a public
// CORS proxy, which would mean handing your key to a stranger's server.
//
// This is deliberately not an open proxy. It forwards only to the hosts listed below, so it cannot be
// found and used to relay traffic anywhere else.

const ALLOWED_HOSTS = new Set([
    'integrate.api.nvidia.com',      // NVIDIA NIM
    'api.groq.com',                  // Groq
    'api.cerebras.ai',               // Cerebras
    'api.mistral.ai',                // Mistral
    'models.github.ai',              // GitHub Models
    'models.inference.ai.azure.com', // GitHub Models, older address
    'openrouter.ai',                 // OpenRouter, though it does not need this
    'generativelanguage.googleapis.com', // Gemini, though it does not need this either
    'api.openai.com',
    'api.anthropic.com',
    'api.deepseek.com',
    'api.together.xyz',
    'api.fireworks.ai',
]);

// Headers worth passing on. Anything else is dropped, including the ones the browser sets about
// itself, which some providers reject.
const FORWARD_REQUEST_HEADERS = [
    'authorization',
    'content-type',
    'accept',
    'x-api-key',
    'x-title',
    'http-referer',
    'api-key',
];

const FORWARD_RESPONSE_HEADERS = [
    'content-type',
    'cache-control',
];

// How long to wait for a provider before giving up.
//
// There was no limit at all before, at any point in the chain. A provider that accepted the connection
// and then said nothing left the request open, and the app sat on "Connecting..." with no error, no
// timeout and nothing to click. That is worse than a failure, because a failure tells you something.
//
// Two and a half minutes is long enough for a very large model to think and short enough that nobody
// believes the app has stopped working. Override with CAST_PROXY_TIMEOUT_MS.
const DEFAULT_TIMEOUT_MS = 150000;

// Hosts added by whoever is running this, through CAST_PROXY_EXTRA_HOSTS.
//
// For self hosting and for development. A host added this way may be plain http, because the reason to
// add one is usually a model running on your own machine or network, where there is no certificate.
// The built in list stays https only.
function parseExtraHosts(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
}

const ALLOW_HEADERS = [
    'Authorization', 'Content-Type', 'Accept', 'X-Cast-Target',
    'X-Api-Key', 'X-Title', 'HTTP-Referer', 'Api-Key',
];

function corsHeaders(origin) {
    return {
        // Any origin, because the proxy is part of your own site and is limited by the host list
        // above rather than by who is calling it.
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': ALLOW_HEADERS.join(', '),
        'Access-Control-Max-Age': '86400',
    };
}

// Decides what to do with a request, without doing any of it.
//
// Given the method, the headers and the address asked for, it returns one of three things: a
// preflight answer, a refusal with a reason a person can act on, or permission to forward along with
// the exact address and headers to use. Both wrappers then carry that out in whatever way their own
// runtime expects.
//
// Keeping the deciding apart from the doing is what makes this testable without a network, a server,
// or a provider key.
function planRequest({ method, headers, url, extraHosts }) {
    const extra = new Set(
        Array.isArray(extraHosts) ? extraHosts.map((h) => String(h).toLowerCase()) : parseExtraHosts(extraHosts)
    );
    const get = (name) => {
        if (!headers) return null;
        if (typeof headers.get === 'function') return headers.get(name);
        // A plain object, as Node's http module provides. Node lowercases its header names.
        const found = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
        return found === undefined ? null : found;
    };

    const origin = get('origin') || '*';

    // The browser asks permission before sending anything with an Authorization header. Without an
    // answer to this, the real request is never sent and the failure looks like a network error
    // rather than a missing permission.
    if (String(method).toUpperCase() === 'OPTIONS') {
        return { action: 'preflight', status: 204, headers: corsHeaders(origin), origin };
    }

    // Where to forward to. Given as a header so it survives any path rewriting, with a query
    // parameter accepted as well for convenience.
    let asked = get('x-cast-target');
    if (!asked && url) {
        try {
            asked = new URL(url, 'http://localhost').searchParams.get('target');
        } catch (error) {
            asked = null;
        }
    }

    if (!asked) {
        return refuse(400, 'No target was given. Set the X-Cast-Target header to the full provider URL.', origin);
    }

    let target;
    try {
        target = new URL(asked);
    } catch (error) {
        return refuse(400, `That target is not a valid address: ${asked}`, origin);
    }

    const hostname = target.hostname.toLowerCase();
    const addedByYou = extra.has(hostname);

    // Plain http only for a host you added yourself, which is normally something on your own machine.
    if (target.protocol !== 'https:' && !(addedByYou && target.protocol === 'http:')) {
        return refuse(400, 'Only https targets are allowed.', origin);
    }

    if (!ALLOWED_HOSTS.has(hostname) && !addedByYou) {
        return refuse(
            403,
            `${target.hostname} is not on this proxy's list of allowed providers. `
            + 'Add it to ALLOWED_HOSTS in proxy-rules.js if you trust it, or set '
            + 'CAST_PROXY_EXTRA_HOSTS when starting the server.',
            origin
        );
    }

    const outgoing = {};
    FORWARD_REQUEST_HEADERS.forEach((name) => {
        const value = get(name);
        if (value) outgoing[name] = value;
    });

    return {
        action: 'forward',
        target: target.toString(),
        hostname: target.hostname,
        headers: outgoing,
        responseHeaders: corsHeaders(origin),
        origin,
    };
}

function refuse(status, message, origin) {
    return {
        action: 'refuse',
        status,
        origin,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
        body: JSON.stringify({ error: { code: status, message, source: 'cast-proxy' } }),
    };
}

// The message when the provider itself could not be reached. Worth its own function so both wrappers
// word it the same way, since this is the one a person is most likely to see.
function unreachable(hostname, reason, origin) {
    return refuse(502, `The proxy could not reach ${hostname}: ${reason}`, origin);
}

// Makes the forwarded request, and gives up rather than waiting forever.
//
// This is here rather than in each of the two proxies because it is the part that was never actually
// tested. The earlier test claimed to go from browser to provider and back and did not: the stand in
// provider was on plain http, which the rules refuse, so the test quietly checked the planning and
// skipped the forwarding. With fetch passed in, the real thing can be tested with nothing running.
//
// Returns { ok: true, response } or { ok: false, refusal }.
async function forwardThrough(plan, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;

    if (!fetchImpl) {
        return { ok: false, refusal: refuse(500, 'This runtime has no fetch.', plan.origin) };
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timedOut = false;
    const timer = controller
        ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs)
        : null;

    try {
        const response = await fetchImpl(plan.target, {
            method: options.method || 'POST',
            headers: plan.headers,
            body: options.body,
            signal: controller ? controller.signal : undefined,
        });
        return { ok: true, response };
    } catch (error) {
        if (timedOut) {
            return {
                ok: false,
                refusal: refuse(
                    504,
                    `${plan.hostname} accepted the connection but sent nothing back within `
                    + `${Math.round(timeoutMs / 1000)} seconds, so the request was given up on. `
                    + 'A very large model can be slow; try a smaller one, or raise the limit with '
                    + 'CAST_PROXY_TIMEOUT_MS.',
                    plan.origin
                ),
            };
        }
        return { ok: false, refusal: unreachable(plan.hostname, error.message, plan.origin) };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

module.exports = {
    DEFAULT_TIMEOUT_MS,
    parseExtraHosts,
    forwardThrough,
    ALLOWED_HOSTS,
    FORWARD_REQUEST_HEADERS,
    FORWARD_RESPONSE_HEADERS,
    ALLOW_HEADERS,
    corsHeaders,
    planRequest,
    refuse,
    unreachable,
};
