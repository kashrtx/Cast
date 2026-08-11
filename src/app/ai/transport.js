// Getting a request out of the browser, and explaining it when it does not go.
//
// Some providers refuse a request that comes straight from a page, so those go through the proxy
// instead. Which ones, and where the proxy is, is decided here. A provider that has already
// refused is remembered, so the app stops hammering it.
//
// The larger half of this file is about failure. A provider that says no says it in its own shape,
// often as a wall of JSON, and a person reading it needs one sentence about what to change. Turning
// the first into the second is most of what is below.

// Whether the last request went through the proxy, so a failure can be attributed correctly.
let lastRequestUsedProxy = false;

// What went wrong, including the provider's own words.
//
// The generic message alone sent people to check the wrong setting. A 404 was always reported as a
// bad model name, when it can equally mean the address is wrong or the request never reached the
// provider at all. The response body usually says which.
function describeProviderFailure(status, bodyText, provider) {
    const base = CastProviders.describeFailure(status, '', provider);
    const body = String(bodyText || '').trim();
    if (!body) return base;

    let detail = '';
    try {
        const parsed = JSON.parse(body);
        const inner = parsed && parsed.error ? parsed.error : parsed;
        detail = (inner && (inner.message || inner.detail || inner.title)) || '';
    } catch (error) {
        detail = body.slice(0, 160);
    }

    return detail ? `${base} It said: ${String(detail).slice(0, 200)}` : base;
}

// Where the proxy is, if there is one.
//
// A deployed site has the function sitting alongside it, so the address can be worked out.
// Opened from a file there is no server, so there can be no proxy.
function getProxyUrl() {
    const configured = String((appSettings.proxyUrl || '')).trim();
    if (configured) return configured.replace(/\/+$/, '');
    return CastProviders.defaultProxyUrl(window.location.origin, window.location.protocol);
}

// Providers that were blocked once, so the next request goes straight through the proxy rather
// than failing first and retrying every single time.
const blockedProviders = new Set();

// How long to wait on a provider before giving up.
//
// Long enough for a very large model to think, short enough that nobody concludes the app has stopped
// working. Adjustable, because a 500 billion parameter model on a free tier really can take minutes,
// and because no single number is right for every provider.
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 150;
const MIN_REQUEST_TIMEOUT_SECONDS = 1;
const MAX_REQUEST_TIMEOUT_SECONDS = 600;

function getRequestTimeoutMs() {
    const configured = Number(appSettings.requestTimeoutSeconds);
    if (!Number.isFinite(configured) || configured <= 0) {
        return DEFAULT_REQUEST_TIMEOUT_SECONDS * 1000;
    }
    const clamped = Math.min(
        MAX_REQUEST_TIMEOUT_SECONDS,
        Math.max(MIN_REQUEST_TIMEOUT_SECONDS, configured)
    );
    return clamped * 1000;
}

// Every request to a provider goes through here.
//
// Some providers refuse requests that come from a web page. The browser blocks those before
// they are sent, and reports it as a plain network failure with no status, which used to look
// like the app was broken. Those requests are sent through a proxy on your own site instead.
async function fetchProvider(url, options, providerId) {
    const provider = getProviderConfig(providerId);
    const proxyUrl = getProxyUrl();

    const mustProxy = CastProviders.alwaysNeedsProxy(provider) || blockedProviders.has(provider.id);
    const canProxy = Boolean(proxyUrl) && !isLocalProvider(provider.id);

    // A page opened straight off the disk has no server behind it, so there is no proxy and no way to
    // make one. Said plainly here, before the request is attempted, because the alternative is a
    // "Failed to fetch" with no status that reads as the app being broken. Retrying, changing the key
    // or changing the model will not help; only serving the app will.
    const fileProblem = CastProviders.fileUrlProxyProblem
        ? CastProviders.fileUrlProxyProblem(window.location.protocol, provider.id, provider)
        : '';
    if (fileProblem && !canProxy) {
        recordActivityIfReady(CastLog.KINDS.PROXY_FAILED, fileProblem);
        throw new Error(fileProblem);
    }

    const attempt = async (viaProxy) => {
        const built = CastProviders.buildRequest({
            provider,
            url,
            proxyUrl,
            viaProxy,
            headers: (options && options.headers) || {},
        });
        lastRequestUsedProxy = built.viaProxy;

        // Every request gets a time limit.
        //
        // There was none, anywhere, and nothing else in the chain had one either. A provider that
        // accepted the connection and then said nothing left the request open for as long as the
        // browser felt like holding it. The app showed "Connecting..." and kept showing it: no error,
        // no timeout, nothing to click, and no way to tell a slow model from a dead one. That is worse
        // than a failure, because a failure tells you something.
        const limitMs = getRequestTimeoutMs();
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let gaveUp = false;
        const timer = controller
            ? setTimeout(() => { gaveUp = true; controller.abort(); }, limitMs)
            : null;

        try {
            const response = await fetch(built.url, Object.assign({}, options, {
                headers: built.headers,
                signal: controller ? controller.signal : undefined,
            }));
            // Carried on the response so the code reading it knows which route it took.
            try { response.viaProxy = built.viaProxy; } catch (error) { /* some browsers seal this */ }
            return response;
        } catch (error) {
            if (gaveUp) {
                const seconds = Math.round(limitMs / 1000);
                throw new Error(
                    `${provider.label} accepted the request and then sent nothing back for ${seconds} `
                    + 'seconds, so it was given up on. A very large model can be slow to start; try a '
                    + 'smaller one, or raise the wait in Settings.'
                );
            }
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    // Straight to the proxy when we already know a direct request will not work.
    if (mustProxy && canProxy) {
        try {
            return await attempt(true);
        } catch (error) {
            throw new Error(
                `Could not reach ${provider.label} through the proxy at ${proxyUrl}. ${provider.label} will not accept requests straight from a web page, so the proxy is required. Check that your site has the function deployed. The browser reported: ${error.message}`
            );
        }
    }

    try {
        return await attempt(false);
    } catch (error) {
        if (isLocalProvider(provider.id)) {
            throw new Error(`Could not reach ${provider.label} at ${url}.${getLocalProviderBridgeHint(url)} The browser reported: ${error.message}`);
        }

        // The browser refused to send it. If a proxy is available and this provider is one that
        // might need it, try again that way and remember the answer.
        const blocked = CastProviders.looksBlockedByBrowser(error);
        if (blocked && canProxy && CastProviders.canRetryThroughProxy(provider)) {
            try {
                const response = await attempt(true);
                blockedProviders.add(provider.id);
                console.log(`${provider.label} will not accept requests from a web page, so it is going through the proxy from now on.`);
                return response;
            } catch (proxyError) {
                throw new Error(
                    `Could not reach ${provider.label} directly or through the proxy. ${proxyError.message}`
                );
            }
        }

        if (blocked && !proxyUrl) {
            throw new Error(
                `${provider.label} will not accept requests sent straight from a web page, and no proxy is set up. Deploy this app to Netlify, which includes the proxy, or set a proxy address in Settings. Opening the file directly cannot work for this provider.`
            );
        }

        throw new Error(
            `Could not reach ${provider.label}. The browser reported: ${error.message}`
        );
    }
}

async function readErrorBody(response) {
    try {
        return await response.text();
    } catch (error) {
        return "";
    }
}

// Was this the proxy failing rather than the provider?
//
// The proxy always answers with JSON that names itself. A page of HTML, or anything else, means the
// request reached the site but never reached the function, which almost always means it is not
// deployed or not routed. That used to be reported as the provider rejecting the model name, which
// sent people to check a setting that was perfectly fine.
function describeProxyFailure(response, bodyText, proxyUrl) {
    const body = String(bodyText || '');

    let parsed = null;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        parsed = null;
    }

    // The proxy speaking for itself. Pass its own message along.
    if (parsed && parsed.error && parsed.error.source === 'cast-proxy') {
        return `The proxy refused: ${parsed.error.message}`;
    }

    // Anything that looks like a web page rather than an answer.
    if (/^\s*<(!doctype|html)/i.test(body) || response.status === 404) {
        return `The proxy at ${proxyUrl} is not responding. The site answered with ${response.status} instead of the function running. Check that netlify/functions is committed and that the deploy log shows the function being bundled.`;
    }

    return '';
}
