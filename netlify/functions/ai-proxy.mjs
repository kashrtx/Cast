// A proxy for providers that refuse requests from a web page.
//
// Why this is needed
//
// A browser will not let a page call an API on another domain unless that API says it is
// allowed, by sending back CORS headers. Google Gemini and OpenRouter do send them, so those
// work straight from the page. NVIDIA NIM does not, and has been asked to for years without it
// happening, so a request to it from the browser fails before it is even sent. The browser
// reports that as "Failed to fetch" with no status code, which looks like the app is broken
// when in fact the request never left.
//
// A server has no such restriction. This function runs on your own Netlify site, takes the
// request, makes it from the server side, and hands the answer back with the headers the
// browser needs. Nothing else changes.
//
// Your key
//
// The key travels from your browser to your own Netlify function and on to the provider. It is
// not stored, not logged, and not sent anywhere else. That is the reason to run your own proxy
// rather than use a public one: with a public CORS proxy you would be handing your key to a
// stranger's server.
//
// This is deliberately not an open proxy. It will only forward to the provider hosts listed
// below, so it cannot be found and used to relay traffic to anywhere else.

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

// Headers worth passing on. Anything else is dropped, including the ones the browser sets
// about itself, which some providers reject.
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

function corsHeaders(origin) {
    return {
        // Any origin, because this proxy is part of your own site and is limited by the host
        // list above rather than by who is calling it.
        'Access-Control-Allow-Origin': origin || '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-Cast-Target, X-Api-Key, X-Title, HTTP-Referer, Api-Key',
        'Access-Control-Max-Age': '86400',
    };
}

function problem(message, status, origin) {
    return new Response(JSON.stringify({ error: { code: status, message, source: 'cast-proxy' } }), {
        status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
    });
}

export default async (request) => {
    const origin = request.headers.get('origin') || '*';

    // The browser asks permission before sending anything with an Authorization header. Without
    // a reply to this, the real request is never sent and the failure looks like a network
    // error rather than a missing permission.
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Where to forward to. Given as a header so it survives any path rewriting, with a query
    // parameter accepted as well for convenience.
    const requestUrl = new URL(request.url);
    const target = request.headers.get('x-cast-target') || requestUrl.searchParams.get('target');

    if (!target) {
        return problem('No target was given. Set the X-Cast-Target header to the full provider URL.', 400, origin);
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
    } catch (error) {
        return problem(`That target is not a valid address: ${target}`, 400, origin);
    }

    if (targetUrl.protocol !== 'https:') {
        return problem('Only https targets are allowed.', 400, origin);
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
        return problem(
            `${targetUrl.hostname} is not on this proxy's list of allowed providers. Add it to ALLOWED_HOSTS in netlify/functions/ai-proxy.mjs if you trust it.`,
            403,
            origin
        );
    }

    // Build the outgoing request, carrying only the headers that matter.
    const headers = new Headers();
    FORWARD_REQUEST_HEADERS.forEach((name) => {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    });

    const init = {
        method: request.method,
        headers,
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        // Read as text rather than piping, so the body is complete before it goes out. These are
        // small JSON payloads, so nothing is gained by streaming the request.
        init.body = await request.text();
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl.toString(), init);
    } catch (error) {
        return problem(
            `The proxy could not reach ${targetUrl.hostname}: ${error.message}`,
            502,
            origin
        );
    }

    const responseHeaders = new Headers(corsHeaders(origin));
    FORWARD_RESPONSE_HEADERS.forEach((name) => {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
    });

    // The body is passed straight through, so a streamed reply stays streamed.
    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
    });
};

export const config = {
    path: '/api/proxy',
};
