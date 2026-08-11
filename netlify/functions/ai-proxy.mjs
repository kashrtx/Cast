// The proxy, for a deployed site.
//
// All the deciding is in proxy-rules.js at the top of the repository, shared with the development
// server in server.js. This file is only the part that has to be written the way Netlify expects:
// take a Request, hand back a Response.
//
// It used to hold its own copy of the allowed hosts and the header lists. The development server now
// runs the same proxy, and two copies of a list is how you end up with a provider that works locally
// and not once deployed, or the other way round.
//
// See proxy-rules.js for why a proxy is needed at all, and what happens to your key.

import rules from '../../proxy-rules.js';

export default async (request) => {
    const plan = rules.planRequest({
        method: request.method,
        headers: request.headers,
        url: request.url,
    });

    if (plan.action === 'preflight') {
        return new Response(null, { status: plan.status, headers: plan.headers });
    }

    if (plan.action === 'refuse') {
        return new Response(plan.body, { status: plan.status, headers: plan.headers });
    }

    let body;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        // Read as text rather than piping, so the body is complete before it goes out. These are
        // small JSON payloads, so nothing is gained by streaming the request.
        body = await request.text();
    }

    // Forwarded with a time limit. Without one, a provider that accepts the connection and then says
    // nothing holds the request open until the platform kills it, and the app shows no error at all.
    const outcome = await rules.forwardThrough(plan, { method: request.method, body });

    if (!outcome.ok) {
        return new Response(outcome.refusal.body, {
            status: outcome.refusal.status,
            headers: outcome.refusal.headers,
        });
    }

    const upstream = outcome.response;

    const responseHeaders = new Headers(plan.responseHeaders);
    rules.FORWARD_RESPONSE_HEADERS.forEach((name) => {
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

// Deliberately no path config here.
//
// Declaring a custom path and also having a redirect in netlify.toml means two mechanisms trying to
// route the same address, and the result was a 404 from the site rather than the function ever
// running. The function stays at its default address and the redirect provides the tidy one.
