// Providers.
//
// The design goal here is that this file should not need editing when models
// change, and adding a provider should be a few lines of config rather than new
// code.
//
// Most services now speak the same dialect as OpenAI's chat completions
// endpoint. OpenRouter, NVIDIA NIM, Groq, Cerebras, Mistral, GitHub Models and
// LM Studio all do. So there is one adapter for all of them, and the difference
// between them is just a base address, how the key is sent, and a note about
// their free tier. Gemini and Ollama have their own shapes, so they get their
// own small adapters.
//
// Two deliberate decisions about model names.
//
// First, the model is always something you type. Every provider on this list
// changes its catalogue regularly, and free tiers in particular come and go
// week by week, so a fixed dropdown would be wrong within days of shipping.
// There are suggestions, and where a provider offers a list endpoint the app can
// fetch the real current catalogue, but typing your own name always works.
//
// Second, there is a Custom option pointing at any address that speaks the
// OpenAI dialect. When a new service appears, you can use it straight away
// without waiting for a code change.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastProviders = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // Auth styles.
    const AUTH = {
        BEARER: "bearer",     // Authorization: Bearer KEY
        NONE: "none",         // local servers that need nothing
        GEMINI_SDK: "gemini", // handled by the Google SDK
    };

    const KIND = {
        OPENAI: "openai-compatible",
        GEMINI: "gemini",
        OLLAMA: "ollama",
    };

    // The registry.
    //
    // suggestedModels are hints for the type ahead list only. They are never
    // required and the app does not stop you using anything else. They are
    // ordered with the most useful first.
    const PROVIDERS = {
        gemini: {
            id: "gemini",
            // Sends the headers a browser needs, so it works straight from the page.
            cors: "direct",
            label: "Google Gemini",
            kind: KIND.GEMINI,
            auth: AUTH.GEMINI_SDK,
            needsKey: true,
            free: true,
            freeNote: "Free tier through Google AI Studio. The most capable free option.",
            keyUrl: "https://aistudio.google.com/apikey",
            // Gemini is not OpenAI shaped, so its model list lives at its own
            // address and the key goes in the query string rather than a header.
            // This was missing, which is why Load available models always came
            // back with nothing for Gemini.
            baseUrl: "https://generativelanguage.googleapis.com/v1beta",
            modelsPath: "/models",
            defaultModel: "gemini-3.6-flash",
            suggestedModels: [
                "gemini-3.6-flash",
                "gemini-3.5-flash-lite",
                "gemini-3.5-flash",
                "gemini-flash-latest",
                "gemini-2.5-flash",
            ],
        },

        openrouter: {
            id: "openrouter",
            // Built for browser use and sends the headers, so no proxy is needed.
            cors: "direct",
            label: "OpenRouter",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Many models are free. Anything ending in :free costs nothing. No card needed.",
            keyUrl: "https://openrouter.ai/keys",
            baseUrl: "https://openrouter.ai/api/v1",
            modelsPath: "/models",
            // OpenRouter's list endpoint reports prices, so the app can work out
            // which models are actually free right now instead of guessing.
            supportsFreeFilter: true,
            defaultModel: "",
            suggestedModels: [],
            extraHeaders: {
                // OpenRouter asks apps to identify themselves. Harmless, and it
                // keeps requests from looking anonymous.
                "X-Title": "Cast",
            },
        },

        nvidia: {
            id: "nvidia",
            // Does not send the headers a browser needs, so requests from a page are blocked
            // before they are sent. This one has to go through a proxy.
            cors: "proxy",
            label: "NVIDIA NIM",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Free credits with a developer account, no card needed. Keys start with nvapi-.",
            keyUrl: "https://build.nvidia.com/",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },

        groq: {
            id: "groq",
            // Unclear and has changed before, so it tries directly first and falls back to the
            // proxy if the browser blocks it.
            cors: "try-direct",
            label: "Groq",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Free tier, no card needed. By far the fastest replies of anything here.",
            keyUrl: "https://console.groq.com/keys",
            baseUrl: "https://api.groq.com/openai/v1",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },

        cerebras: {
            id: "cerebras",
            cors: "try-direct",
            label: "Cerebras",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Free tier with a generous daily allowance. Very fast.",
            keyUrl: "https://cloud.cerebras.ai/",
            baseUrl: "https://api.cerebras.ai/v1",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },

        mistral: {
            id: "mistral",
            cors: "try-direct",
            label: "Mistral",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Free tier with a large monthly allowance. Note that the free tier opts you into training.",
            keyUrl: "https://console.mistral.ai/api-keys/",
            baseUrl: "https://api.mistral.ai/v1",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },

        github: {
            id: "github",
            cors: "proxy",
            label: "GitHub Models",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: true,
            free: true,
            freeNote: "Free with a GitHub token that has the models read permission. Broad model choice.",
            keyUrl: "https://github.com/settings/personal-access-tokens/new",
            baseUrl: "https://models.github.ai/inference",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },

        ollama: {
            id: "ollama",
            // On your own machine, so a proxy would not help. Ollama has its own setting for
            // allowing browser requests.
            cors: "direct",
            label: "Ollama (on your own machine)",
            kind: KIND.OLLAMA,
            auth: AUTH.NONE,
            needsKey: false,
            free: true,
            freeNote: "Runs on your own computer. Completely free and private.",
            keyUrl: "https://ollama.com/download",
            baseUrl: "http://localhost:11434",
            modelsPath: "/api/tags",
            defaultModel: "gemma3:12b",
            suggestedModels: ["gemma3:12b", "qwen3:14b", "phi4", "llama3.3:70b", "mistral-nemo"],
        },

        lmstudio: {
            id: "lmstudio",
            cors: "direct",
            label: "LM Studio (on your own machine)",
            kind: KIND.OPENAI,
            auth: AUTH.NONE,
            needsKey: false,
            free: true,
            freeNote: "Runs on your own computer. Completely free and private.",
            keyUrl: "https://lmstudio.ai/",
            baseUrl: "http://localhost:1234/v1",
            modelsPath: "/models",
            defaultModel: "local-model",
            suggestedModels: ["local-model"],
        },

        custom: {
            id: "custom",
            cors: "try-direct",
            label: "Custom (anything OpenAI compatible)",
            kind: KIND.OPENAI,
            auth: AUTH.BEARER,
            needsKey: false,
            free: null,
            freeNote: "Point this at any service that speaks the OpenAI chat format. Use it for providers that did not exist when this app was built.",
            keyUrl: "",
            baseUrl: "",
            modelsPath: "/models",
            defaultModel: "",
            suggestedModels: [],
        },
    };

    const PROVIDER_ORDER = [
        "gemini",
        "openrouter",
        "nvidia",
        "groq",
        "cerebras",
        "mistral",
        "github",
        "ollama",
        "lmstudio",
        "custom",
    ];

    // Old settings used these names. Anyone upgrading keeps their choice.
    const LEGACY_PROVIDER_IDS = {
        "gemini": "gemini",
        "ollama": "ollama",
        "lmstudio": "lmstudio",
        "lm_studio": "lmstudio",
        "lm-studio": "lmstudio",
    };

    // Old Gemini model names that no longer exist, mapped to the closest current
    // one. This is what makes a backup from a year ago open on a working model
    // instead of one that was retired.
    const LEGACY_MODEL_NAMES = {
        "gemini-2.0-flash": "gemini-2.5-flash",
        "gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
        "gemini-2.0-pro": "gemini-3.6-flash",
        "gemini-1.5-flash": "gemini-2.5-flash",
        "gemini-1.5-pro": "gemini-3.6-flash",
        "gemini-pro": "gemini-3.6-flash",
        "gemini-3-flash-preview": "gemini-3.6-flash",
        "gemini-3-pro-preview": "gemini-3.6-flash",
        "gemini-3.1-flash-lite": "gemini-3.5-flash-lite",
        "gemini-3.1-pro-preview": "gemini-3.6-flash",
        "gemini-3.5-flash": "gemini-3.5-flash",
    };

    function getProvider(id) {
        const resolved = LEGACY_PROVIDER_IDS[id] || id;
        return PROVIDERS[resolved] || PROVIDERS.gemini;
    }

    function listProviders() {
        return PROVIDER_ORDER.map((id) => PROVIDERS[id]);
    }

    function isKnownProvider(id) {
        const resolved = LEGACY_PROVIDER_IDS[id] || id;
        return Object.prototype.hasOwnProperty.call(PROVIDERS, resolved);
    }

    // Maps a retired model name onto a current one. Unknown names are left
    // exactly as typed, because a name this app has never heard of is far more
    // likely to be a new model than a mistake.
    function migrateModelName(name) {
        if (typeof name !== "string" || !name.trim()) return "";
        const trimmed = name.trim();
        return LEGACY_MODEL_NAMES[trimmed] || trimmed;
    }

    // Tidies a base address. Trailing slashes cause double slashes in request
    // paths, which some services reject.
    function normaliseBaseUrl(url, fallback) {
        const candidate = typeof url === "string" ? url.trim() : "";
        const chosen = candidate || fallback || "";
        return chosen.replace(/\/+$/, "");
    }

    // LM Studio needs the /v1 suffix. People routinely leave it off.
    function ensureVersionSuffix(url) {
        const base = normaliseBaseUrl(url);
        if (!base) return base;
        return /\/v\d+$/.test(base) ? base : `${base}/v1`;
    }

    function resolveBaseUrl(provider, settings) {
        const configured = settings && settings.baseUrls ? settings.baseUrls[provider.id] : "";
        const base = normaliseBaseUrl(configured, provider.baseUrl);
        if (provider.id === "lmstudio") return ensureVersionSuffix(base);
        return base;
    }

    function buildHeaders(provider, key) {
        const headers = { "Content-Type": "application/json" };

        if (provider.auth === AUTH.BEARER && key) {
            headers.Authorization = `Bearer ${key}`;
        }

        if (provider.extraHeaders) {
            Object.keys(provider.extraHeaders).forEach((name) => {
                headers[name] = provider.extraHeaders[name];
            });
        }

        return headers;
    }

    // Builds the body for an OpenAI style chat request.
    //
    // Note what is not here. There is no instruction telling the model not to
    // think. That approach never worked. Instead we ask the API to keep
    // reasoning short using the switches it actually understands, and rely on
    // the thinking module to tell reasoning and reply apart afterwards.
    function buildChatBody({ model, messages, maxTokens, temperature, stream }) {
        const body = {
            model,
            messages,
            temperature: typeof temperature === "number" ? temperature : 1,
            max_tokens: maxTokens,
            stream: Boolean(stream),
        };

        // Understood by Ollama's OpenAI endpoint, LM Studio and several hosted
        // services. Anything that does not know it ignores it.
        body.reasoning_effort = "low";

        return body;
    }

    // Gemini's own configuration.
    //
    // Gemini 3 models take thinkingLevel and default to high, which is why
    // roleplay replies were slow and sometimes never arrived within the token
    // limit. We ask for low.
    //
    // We deliberately do not ask for minimal. Minimal expects the app to hand
    // back thought signatures on later turns, and this app rebuilds its history
    // from stored plain text, so minimal would be fragile here. Low is the
    // safest setting that still keeps reasoning short.
    //
    // Gemini 2.5 models use a token budget instead, where zero switches
    // reasoning off completely.
    function buildGeminiConfig({ model, maxTokens, temperature }) {
        const config = {
            temperature: typeof temperature === "number" ? temperature : 1,
            maxOutputTokens: maxTokens,
        };

        const name = String(model || "").toLowerCase();

        if (name.includes("gemini-2.5")) {
            config.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
        } else if (name.includes("gemini-3") || name.includes("flash-latest") || name.includes("pro-latest")) {
            config.thinkingConfig = { thinkingLevel: "low", includeThoughts: false };
        }

        return config;
    }

    // Works out a sensible token limit. Reasoning models share one budget
    // between their working out and the reply, so a small limit means the reply
    // can get squeezed out entirely. That is what happened with the old default
    // of three hundred.
    function resolveTokenLimit(requested, fallback) {
        const parsed = parseInt(requested, 10);
        const base = Number.isFinite(parsed) && parsed > 0 ? parsed : (fallback || 4096);
        return Math.min(Math.max(base, 256), 65536);
    }

    // Warns when the limit is low enough that a reasoning model will struggle.
    function tokenLimitWarning(limit, providerId, model) {
        const value = parseInt(limit, 10);
        if (!Number.isFinite(value)) return null;
        if (value >= 1024) return null;
        return "This response limit is quite low. Models that reason before answering share this budget between their thinking and their reply, so a low limit can leave no room for the reply. Around 2048 or more is a safer choice.";
    }

    // Reads a list of models out of whatever shape the provider returned.
    // Handles the OpenAI style data array, Ollama's models array, and a bare
    // array of strings.
    function parseModelList(payload, options) {
        const wantFreeOnly = Boolean(options && options.freeOnly);
        const out = [];

        if (!payload) return out;

        if (Array.isArray(payload)) {
            payload.forEach((entry) => {
                if (typeof entry === "string") out.push({ id: entry, free: null });
                else if (entry && entry.id) out.push({ id: entry.id, free: null });
            });
            return out;
        }

        // OpenAI style.
        if (Array.isArray(payload.data)) {
            payload.data.forEach((entry) => {
                if (!entry) return;
                const id = entry.id || entry.name;
                if (!id) return;

                // OpenRouter reports prices as strings such as "0" or "0.0000015".
                let free = null;
                if (entry.pricing) {
                    const prompt = parseFloat(entry.pricing.prompt);
                    const completion = parseFloat(entry.pricing.completion);
                    if (Number.isFinite(prompt) && Number.isFinite(completion)) {
                        free = prompt === 0 && completion === 0;
                    }
                }
                if (free === null && typeof id === "string" && id.endsWith(":free")) {
                    free = true;
                }

                out.push({ id, free, label: entry.name || id });
            });
        }

        // Ollama and Gemini both use a models array, but Gemini prefixes each
        // name with "models/" and lists what each one can do.
        if (Array.isArray(payload.models)) {
            payload.models.forEach((entry) => {
                if (!entry) return;
                let id = entry.name || entry.model || entry.id;
                if (!id) return;

                // "models/gemini-3.6-flash" becomes "gemini-3.6-flash".
                id = String(id).replace(/^models\//, "");

                // Gemini lists embedding and image models here too. Only keep the
                // ones that can actually hold a conversation.
                if (Array.isArray(entry.supportedGenerationMethods)) {
                    const canChat = entry.supportedGenerationMethods.some((method) =>
                        method === "generateContent" || method === "streamGenerateContent"
                    );
                    if (!canChat) return;
                }

                out.push({ id, free: true, label: entry.displayName || id });
            });
        }

        if (!wantFreeOnly) return out;

        const freeOnes = out.filter((entry) => entry.free === true);
        // If nothing looks free, show everything rather than an empty list.
        return freeOnes.length ? freeOnes : out;
    }

    // Turns a failed response into something worth reading.
    function describeFailure(status, bodyText, provider) {
        const snippet = typeof bodyText === "string" ? bodyText.slice(0, 300) : "";
        const label = provider ? provider.label : "The provider";

        if (status === 401 || status === 403) {
            return `${label} rejected the API key. Check that it is correct and still active.`;
        }
        if (status === 404) {
            return `${label} does not recognise that model name. Check the spelling against the provider's model list.`;
        }
        if (status === 429) {
            return `${label} is rate limiting you. Free tiers have per minute and per day caps, so wait a moment and try again.`;
        }
        if (status === 402) {
            return `${label} says this model needs credit. Try a free model instead.`;
        }
        if (status >= 500) {
            return `${label} had a server problem. This is on their end, so try again shortly.`;
        }
        return `${label} returned an error (${status}).${snippet ? ` ${snippet}` : ""}`;
    }

    // Turns a provider's error into one sentence a person can act on.
    //
    // Providers return enormous machine readable errors. Gemini's rate limit reply is
    // about two thousand characters of nested JSON. Putting that straight into a banner
    // filled the screen and pushed the message box out of view, so the app looked broken
    // on top of the actual problem.
    //
    // This pulls out the three things worth knowing: what went wrong, how long to wait,
    // and what to do instead.
    function describeProviderError(error, provider) {
        const label = provider && provider.label ? provider.label : "The provider";
        const raw = error && error.message ? String(error.message) : String(error || "");

        // The useful part is usually JSON, sometimes with text in front of it.
        let payload = null;
        const firstBrace = raw.indexOf("{");
        if (firstBrace !== -1) {
            try {
                payload = JSON.parse(raw.slice(firstBrace));
            } catch (parseError) {
                payload = null;
            }
        }

        const body = payload && payload.error ? payload.error : payload;
        const code = body && body.code ? Number(body.code) : null;
        const status = body && body.status ? String(body.status) : "";

        // How long to wait, if it said.
        let retrySeconds = null;
        const details = body && Array.isArray(body.details) ? body.details : [];
        details.forEach((detail) => {
            if (!detail) return;
            const delay = detail.retryDelay || detail.retry_delay;
            if (delay) {
                const parsed = parseFloat(String(delay));
                if (Number.isFinite(parsed)) retrySeconds = Math.ceil(parsed);
            }
        });
        if (retrySeconds === null) {
            const spotted = raw.match(/retry in ([\d.]+)s/i);
            if (spotted) retrySeconds = Math.ceil(parseFloat(spotted[1]));
        }

        // Which limit, and which model.
        let limit = null;
        let model = null;
        let perDay = false;
        details.forEach((detail) => {
            const violations = detail && Array.isArray(detail.violations) ? detail.violations : [];
            violations.forEach((violation) => {
                if (!violation) return;
                if (violation.quotaValue) limit = String(violation.quotaValue);
                if (violation.quotaDimensions && violation.quotaDimensions.model) {
                    model = String(violation.quotaDimensions.model);
                }
                if (violation.quotaId && /PerDay/i.test(String(violation.quotaId))) perDay = true;
            });
        });

        const wait = retrySeconds !== null
            ? (retrySeconds >= 90
                ? ` Try again in about ${Math.ceil(retrySeconds / 60)} minutes.`
                : ` Try again in about ${retrySeconds} seconds.`)
            : "";

        if (code === 429 || status === "RESOURCE_EXHAUSTED") {
            const which = model ? ` for ${model}` : "";
            const howMany = limit ? ` The free allowance is ${limit} requests` : "";
            const period = limit ? (perDay ? " per day." : " per minute.") : "";
            return {
                short: `${label} has hit its free usage limit${which}.${howMany}${period}${wait}`,
                advice: "You can wait, switch to another provider in Settings, or pick a different model.",
                kind: "rate-limited",
                retrySeconds,
            };
        }

        if (code === 401 || code === 403 || status === "UNAUTHENTICATED" || status === "PERMISSION_DENIED") {
            return {
                short: `${label} rejected the API key.`,
                advice: "Check the key in Settings, or make a new one.",
                kind: "bad-key",
                retrySeconds: null,
            };
        }

        if (code === 404 || status === "NOT_FOUND") {
            return {
                short: `${label} does not have a model by that name.`,
                advice: "Check the model name in Settings against the provider's own list.",
                kind: "no-such-model",
                retrySeconds: null,
            };
        }

        if (code === 400 || status === "INVALID_ARGUMENT") {
            const reason = body && body.message ? String(body.message).split("\n")[0].slice(0, 160) : "";
            return {
                short: `${label} refused the request.${reason ? ` ${reason}` : ""}`,
                advice: "This often means the response limit is set too low, or the model name is wrong.",
                kind: "refused",
                retrySeconds: null,
            };
        }

        if (code && code >= 500) {
            return {
                short: `${label} had a problem at their end.${wait}`,
                advice: "Nothing is wrong with your setup. Try again shortly.",
                kind: "provider-down",
                retrySeconds,
            };
        }

        // Anything unrecognised. Keep a short readable piece rather than the whole payload.
        const plain = body && body.message
            ? String(body.message).split("\n")[0]
            : raw.split("\n")[0];
        return {
            short: `${label} returned an error: ${plain.slice(0, 200)}`,
            advice: "The full detail is in the log in Settings.",
            kind: "unknown",
            retrySeconds: null,
        };
    }

    // How a character says that they cannot answer right now.
    //
    // Written as something the character would say, in the third person, so it reads as
    // part of the story rather than as a broken app. It also matters that this counts as a
    // reply, because the continue feature needs a message from each side and would
    // otherwise refuse to work after a failure.
    function characterUnavailableLine({ characterName, userName, description }) {
        const who = characterName || "They";
        const you = userName ? `, ${userName}` : "";
        return `*${who} is unavailable right now${you}.* ${description} The full detail is in the log in Settings, and you can switch provider there too.`;
    }

    // Does this provider need to go through a proxy?
    //
    // "direct" means the API sends the headers a browser requires, so it can be called from the
    // page. "proxy" means it does not, so it cannot. "try-direct" means it is worth trying, and
    // falling back if the browser blocks it, because some providers have changed their minds
    // about this and a fixed answer would go stale.
    // Takes either a provider or its id.
    //
    // It used to take only a provider. Handed a string it found no cors field and returned
    // "try-direct", which is the least cautious answer of the three, so a provider that must be
    // proxied would have been sent straight at the browser instead. Every caller in the app happened
    // to pass a provider, so nothing was broken by it, but a helper whose wrong answer is the unsafe
    // one should not depend on which of two shapes it was given.
    function corsPolicy(provider) {
        const config = typeof provider === "string" ? getProvider(provider) : provider;
        return (config && config.cors) || "try-direct";
    }

    function alwaysNeedsProxy(provider) {
        return corsPolicy(provider) === "proxy";
    }

    function canRetryThroughProxy(provider) {
        return corsPolicy(provider) === "try-direct";
    }

    // Builds the address to actually request.
    //
    // Going through the proxy keeps the real target in a header rather than in the path, so
    // nothing has to be encoded into a URL and no path rewriting can mangle it.
    function buildRequest({ provider, url, proxyUrl, viaProxy, headers }) {
        const outgoing = Object.assign({}, headers || {});

        if (!viaProxy || !proxyUrl) {
            return { url, headers: outgoing, viaProxy: false };
        }

        outgoing["X-Cast-Target"] = url;
        return { url: proxyUrl, headers: outgoing, viaProxy: true };
    }

    // Where the proxy lives.
    //
    // On a deployed site the function sits alongside the app, so the address can be worked out
    // rather than typed. Opened from a file there is no server, so there can be no proxy.
    function defaultProxyUrl(pageOrigin, pageProtocol) {
        if (pageProtocol === "file:") return "";
        if (!pageOrigin) return "";
        return `${pageOrigin.replace(/\/+$/, "")}/api/proxy`;
    }

    // Was this failure the browser refusing to send the request, rather than the provider
    // saying no?
    //
    // A blocked request arrives as a TypeError with no status, because the response never
    // existed. That is the signature worth retrying through a proxy.
    // Why a request cannot be made from a page opened straight off the disk.
    //
    // A provider that sends no CORS headers can only be reached through a proxy, and a proxy has to be
    // a server. A file:// page has no server behind it, so there is nowhere to forward through and no
    // amount of retrying will help. Every attempt comes back as "Failed to fetch" with no status,
    // which reads like the app is broken.
    //
    // Returns the sentence to show, or an empty string when this is not the situation.
    function fileUrlProxyProblem(pageProtocol, providerId, provider) {
        if (pageProtocol !== "file:") return "";
        const config = provider || getProvider(providerId);
        if (!config) return "";
        if (corsPolicy(config) !== "proxy") return "";

        return `${config.label} does not accept requests made directly by a browser, so it has to go `
            + "through a proxy, and a page opened straight from a file has no server behind it to be "
            + "the proxy. Run the app with npm start and open the address it prints. The proxy is part "
            + "of that server, and the app finds it without any setting.";
    }

    function looksBlockedByBrowser(error) {
        if (!error) return false;
        const message = String(error.message || error).toLowerCase();
        return message.includes("failed to fetch")
            || message.includes("networkerror")
            || message.includes("load failed")
            || message.includes("cors")
            || message.includes("could not reach");
    }

    // Advice for when a local server cannot be reached at all. The usual cause
    // is a phone trying to reach localhost, which on a phone means the phone.
    // Advice that depends on where the page is and what it is trying to reach.
    //
    // A browser will not let a page on the open internet quietly reach into your own machine.
    // Chrome calls this Local Network Access and asks permission the first time, and if that
    // prompt is dismissed the request just fails. What to do about it depends on the situation,
    // so the advice does too rather than always suggesting the same thing.
    function localReachabilityHint(pageProtocol, pageHost, bridgeActive, targetUrl) {
        if (bridgeActive) return "";

        const target = String(targetUrl || "");
        const targetsLoopback = /\/\/(localhost|127\.0\.0\.1)\b/.test(target);
        const isLocalPage = pageProtocol === "file:"
            || pageHost === "localhost"
            || pageHost === "127.0.0.1"
            || pageHost === "";

        // Same place as the model, so nothing should be in the way. Point at the server's own
        // settings instead, which is the likely cause.
        if (isLocalPage && targetsLoopback) {
            return " The page and the model are both local, so this is probably the server rather than the browser. Ollama needs OLLAMA_ORIGINS set to allow browser requests. LM Studio allows them by default, so check that it is running and serving on that port.";
        }

        // A page on the internet reaching your own machine. Chrome will ask first.
        if (pageProtocol === "https:" && targetsLoopback) {
            return " Your browser asks permission before a website may reach your own machine, so look for a prompt about connecting to devices on your local network and allow it. If you dismissed it, clear this site's permissions and reload. Installing local-ai-bridge.user.js in Tampermonkey avoids the prompt entirely.";
        }

        // The hard case: a phone reaching a computer across the network.
        if (!targetsLoopback) {
            return " Reaching another machine across your network from a web page is blocked unless you install local-ai-bridge.user.js in Tampermonkey, which is what it exists for. Keep both on the same wifi and use your computer's network address rather than localhost, because on a phone localhost means the phone itself.";
        }

        return "";
    }

    return {
        AUTH,
        KIND,
        PROVIDERS,
        PROVIDER_ORDER,
        LEGACY_PROVIDER_IDS,
        LEGACY_MODEL_NAMES,
        getProvider,
        listProviders,
        isKnownProvider,
        migrateModelName,
        normaliseBaseUrl,
        ensureVersionSuffix,
        resolveBaseUrl,
        buildHeaders,
        buildChatBody,
        buildGeminiConfig,
        resolveTokenLimit,
        tokenLimitWarning,
        parseModelList,
        describeFailure,
        describeProviderError,
        corsPolicy,
        alwaysNeedsProxy,
        canRetryThroughProxy,
        buildRequest,
        defaultProxyUrl,
        fileUrlProxyProblem,
        looksBlockedByBrowser,
        characterUnavailableLine,
        localReachabilityHint,
    };
});
