// ==UserScript==
// @name         Cast Local AI Bridge
// @namespace    https://github.com/cast-rp
// @version      2.0.0
// @description  Lets Cast reach Ollama or LM Studio running on your own machine, including from a phone.
// @author       Cast
// @match        https://castrp.netlify.app/*
// @match        https://*.netlify.app/*
// @match        http://localhost/*
// @match        http://localhost:*/*
// @match        http://127.0.0.1/*
// @match        http://127.0.0.1:*/*
// @match        file:///*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      localhost
// @connect      127.0.0.1
// @connect      10.*
// @connect      172.*
// @connect      192.168.*
// @connect      *.local
// @connect      *
// @run-at       document-start
// ==/UserScript==

// When you need this, and when you do not
//
// A browser will not let a page on the open internet quietly reach into your own machine. Chrome
// calls this Local Network Access. From version 142 it asks permission the first time a public
// site tries to reach localhost or an address on your network, and if the prompt is dismissed the
// request simply fails.
//
// The rule that matters is whether the page and the model are in the same place:
//
//   Page opened from a file, or from localhost, talking to a model on localhost
//     Same address space. No prompt, no problem. You do not need this script.
//
//   The deployed site talking to a model on localhost on the same computer
//     Chrome asks permission. Allow it and it works without this script. This script avoids the
//     prompt entirely, which is handy if you would rather not think about it.
//
//   A phone talking to a model on your computer, using its network address
//     This is the case the script exists for. The page is on the open internet and the target is
//     a private address, so it is blocked, and on a phone there is no useful prompt to accept.
//
// How it works: requests to a local address are sent through Tampermonkey rather than through the
// browser's own fetch, and an extension is not bound by these rules. Nothing else is touched, so
// requests to Gemini or OpenRouter go the normal way.

(function () {
    'use strict';

    const BRIDGE_VERSION = '2.0.0';
    const interceptedPaths = [
        '/api/chat',
        '/api/generate',
        '/api/tags',
        '/v1/chat/completions',
        '/v1/models',
        '/models',
        '/chat/completions',
    ];

    const page = unsafeWindow || window;
    const nativeFetch = page.fetch.bind(page);

    function isPrivateHost(hostname) {
        const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return true;
        if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
        const lanMatch = host.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
        if (lanMatch) {
            const secondOctet = Number(lanMatch[1]);
            return secondOctet >= 16 && secondOctet <= 31;
        }
        return false;
    }

    function shouldBridge(url) {
        if (url.protocol !== 'http:') return false;
        if (!isPrivateHost(url.hostname)) return false;
        return interceptedPaths.some(path => url.pathname === path || url.pathname.endsWith(path));
    }

    function copyHeaders(headersLike, target) {
        if (!headersLike) return;
        if (headersLike instanceof page.Headers || headersLike instanceof Headers) {
            headersLike.forEach((value, key) => {
                target[key] = value;
            });
            return;
        }
        if (Array.isArray(headersLike)) {
            headersLike.forEach(([key, value]) => {
                target[key] = value;
            });
            return;
        }
        Object.entries(headersLike).forEach(([key, value]) => {
            target[key] = value;
        });
    }

    function parseResponseHeaders(rawHeaders) {
        const headers = new page.Headers();
        String(rawHeaders || '').trim().split(/[\r\n]+/).forEach(line => {
            const separator = line.indexOf(':');
            if (separator > 0) {
                headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
            }
        });
        return headers;
    }

    function requestThroughTampermonkey(input, init, url) {
        const requestHeaders = {};
        const request = typeof input === 'object' && input instanceof page.Request ? input : null;
        copyHeaders(request?.headers, requestHeaders);
        copyHeaders(init?.headers, requestHeaders);

        const method = init?.method || request?.method || 'GET';
        const body = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : undefined;

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method,
                url: url.href,
                headers: requestHeaders,
                data: body,
                responseType: 'text',
                timeout: 0,
                onload: response => {
                    resolve(new page.Response(response.responseText || '', {
                        status: response.status || 200,
                        statusText: response.statusText || 'OK',
                        headers: parseResponseHeaders(response.responseHeaders),
                    }));
                },
                onerror: error => reject(new page.TypeError(`Local AI Bridge request failed: ${error.error || 'network error'}`)),
                ontimeout: () => reject(new page.TypeError('Local AI Bridge request timed out')),
                onabort: () => reject(new page.TypeError('Local AI Bridge request was aborted')),
            });
        });
    }

    page.fetch = function bridgedFetch(input, init) {
        const rawUrl = typeof input === 'string' || input instanceof page.URL ? String(input) : input?.url;
        if (!rawUrl) return nativeFetch(input, init);

        let url;
        try {
            url = new page.URL(rawUrl, page.location.href);
        } catch (error) {
            return nativeFetch(input, init);
        }

        if (!shouldBridge(url)) {
            return nativeFetch(input, init);
        }

        return requestThroughTampermonkey(input, init, url);
    };

    page.__GCRP_LOCAL_AI_BRIDGE__ = {
        active: true,
        version: BRIDGE_VERSION,
        startedAt: new Date().toISOString(),
    };

    page.dispatchEvent(new page.CustomEvent('gcrp-local-ai-bridge-ready', {
        detail: page.__GCRP_LOCAL_AI_BRIDGE__,
    }));

    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('Gemini Character RP Local AI Bridge: status', () => {
            page.alert(`Local AI Bridge is active. Version: ${BRIDGE_VERSION}`);
        });
    }

    console.info(`[Gemini Character RP] Local AI Bridge active v${BRIDGE_VERSION}`);
})();
