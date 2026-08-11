const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/providers.js");
const Ids = require("../src/ids.js");
const E = require("../src/escape.js");
const Img = require("../src/images.js");

// --- The provider registry ---

test("every provider in the order list actually exists", () => {
    P.PROVIDER_ORDER.forEach((id) => {
        assert.ok(P.PROVIDERS[id], `${id} is listed but not defined`);
    });
});

test("every provider has the fields the app relies on", () => {
    P.listProviders().forEach((provider) => {
        assert.ok(provider.id, "needs an id");
        assert.ok(provider.label, `${provider.id} needs a label`);
        assert.ok(provider.kind, `${provider.id} needs a kind`);
        assert.ok(provider.auth, `${provider.id} needs an auth style`);
        assert.ok(typeof provider.freeNote === "string", `${provider.id} needs a free tier note`);
    });
});

test("the free providers the brief asked for are present", () => {
    ["openrouter", "nvidia", "groq", "cerebras", "mistral", "github"].forEach((id) => {
        assert.ok(P.PROVIDERS[id], `${id} should be available`);
        assert.strictEqual(P.PROVIDERS[id].free, true, `${id} should be marked free`);
    });
});

test("the providers that already worked are still here", () => {
    ["gemini", "ollama", "lmstudio"].forEach((id) => {
        assert.ok(P.PROVIDERS[id], `${id} must not be dropped`);
    });
});

test("there is a custom option so new services need no code change", () => {
    assert.ok(P.PROVIDERS.custom);
    assert.strictEqual(P.PROVIDERS.custom.kind, P.KIND.OPENAI);
});

test("old provider ids still resolve", () => {
    assert.strictEqual(P.getProvider("lm_studio").id, "lmstudio");
    assert.strictEqual(P.getProvider("lm-studio").id, "lmstudio");
    assert.strictEqual(P.getProvider("gemini").id, "gemini");
});

test("an unknown provider id falls back to gemini rather than breaking", () => {
    assert.strictEqual(P.getProvider("something-that-never-existed").id, "gemini");
});

// --- Model names ---

test("retired gemini names are mapped to current ones", () => {
    // This is the setting in the user's real year old backup.
    assert.strictEqual(P.migrateModelName("gemini-2.0-flash-lite"), "gemini-3.5-flash-lite");
    assert.strictEqual(P.migrateModelName("gemini-1.5-pro"), "gemini-3.6-flash");
});

test("a model name the app has never heard of is left exactly as typed", () => {
    // Important. A new model must work the day it is announced.
    assert.strictEqual(P.migrateModelName("gemini-4.0-ultra"), "gemini-4.0-ultra");
    assert.strictEqual(P.migrateModelName("some-vendor/brand-new-model:free"), "some-vendor/brand-new-model:free");
});

test("whitespace around a typed model name is trimmed", () => {
    assert.strictEqual(P.migrateModelName("  gemini-3.6-flash  "), "gemini-3.6-flash");
});

test("the default gemini model is the current one", () => {
    assert.strictEqual(P.PROVIDERS.gemini.defaultModel, "gemini-3.6-flash");
});

// --- Base addresses ---

test("trailing slashes are removed so paths do not double up", () => {
    assert.strictEqual(P.normaliseBaseUrl("https://example.com/v1///"), "https://example.com/v1");
});

test("lm studio gets its version suffix added when left off", () => {
    assert.strictEqual(P.ensureVersionSuffix("http://localhost:1234"), "http://localhost:1234/v1");
    assert.strictEqual(P.ensureVersionSuffix("http://localhost:1234/v1"), "http://localhost:1234/v1");
});

test("a blank address falls back to the provider default", () => {
    const provider = P.getProvider("groq");
    assert.strictEqual(P.resolveBaseUrl(provider, { baseUrls: {} }), "https://api.groq.com/openai/v1");
});

test("a custom address overrides the default", () => {
    const provider = P.getProvider("groq");
    const url = P.resolveBaseUrl(provider, { baseUrls: { groq: "https://my-proxy.test/v1" } });
    assert.strictEqual(url, "https://my-proxy.test/v1");
});

// --- Headers ---

test("a bearer key is sent as an authorization header", () => {
    const headers = P.buildHeaders(P.getProvider("openrouter"), "sk-test-123");
    assert.strictEqual(headers.Authorization, "Bearer sk-test-123");
    assert.strictEqual(headers["Content-Type"], "application/json");
});

test("local providers send no authorization header", () => {
    const headers = P.buildHeaders(P.getProvider("lmstudio"), "");
    assert.strictEqual(headers.Authorization, undefined);
});

test("openrouter gets its title header", () => {
    const headers = P.buildHeaders(P.getProvider("openrouter"), "k");
    assert.strictEqual(headers["X-Title"], "Cast");
});

// --- Request bodies ---

test("a chat body carries the model, messages and limits", () => {
    const body = P.buildChatBody({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 2048,
        temperature: 0.8,
        stream: true,
    });
    assert.strictEqual(body.model, "test-model");
    assert.strictEqual(body.max_tokens, 2048);
    assert.strictEqual(body.temperature, 0.8);
    assert.strictEqual(body.stream, true);
});

test("a chat body asks for low reasoning effort rather than begging in the prompt", () => {
    const body = P.buildChatBody({ model: "m", messages: [], maxTokens: 100 });
    assert.strictEqual(body.reasoning_effort, "low");
    // The old code pushed an instruction into the messages. It never worked and
    // it polluted the character's persona, so it must not come back.
    const asText = JSON.stringify(body);
    assert.ok(!/disable thinking/i.test(asText));
    assert.ok(!/do not output chain-of-thought/i.test(asText));
});

test("gemini 3 models get a thinking level", () => {
    const config = P.buildGeminiConfig({ model: "gemini-3.6-flash", maxTokens: 2048 });
    assert.strictEqual(config.thinkingConfig.thinkingLevel, "low");
    assert.strictEqual(config.thinkingConfig.includeThoughts, false);
});

test("gemini 2.5 models get a thinking budget of zero", () => {
    const config = P.buildGeminiConfig({ model: "gemini-2.5-flash", maxTokens: 2048 });
    assert.strictEqual(config.thinkingConfig.thinkingBudget, 0);
});

test("gemini config never asks for thoughts to be included", () => {
    ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"].forEach((model) => {
        const config = P.buildGeminiConfig({ model, maxTokens: 1000 });
        if (config.thinkingConfig) {
            assert.strictEqual(config.thinkingConfig.includeThoughts, false, model);
        }
    });
});

// --- Token limits ---

test("a token limit is clamped to something workable", () => {
    assert.strictEqual(P.resolveTokenLimit(0, 4096), 4096);
    assert.strictEqual(P.resolveTokenLimit(-5, 4096), 4096);
    assert.strictEqual(P.resolveTokenLimit("abc", 4096), 4096);
    assert.strictEqual(P.resolveTokenLimit(999999, 4096), 65536);
    assert.strictEqual(P.resolveTokenLimit(2048, 4096), 2048);
});

test("a tiny limit is raised to a floor rather than left to fail", () => {
    // The user's old backup had 300, which on a reasoning model leaves no room
    // for a reply at all.
    assert.strictEqual(P.resolveTokenLimit(300, 4096), 300 < 256 ? 256 : 300);
    assert.strictEqual(P.resolveTokenLimit(10, 4096), 256);
});

test("a low limit produces a warning that explains the real cause", () => {
    const warning = P.tokenLimitWarning(300, "gemini", "gemini-3.6-flash");
    assert.ok(warning);
    assert.ok(/thinking|reason/i.test(warning));
    assert.strictEqual(P.tokenLimitWarning(4096, "gemini", "gemini-3.6-flash"), null);
});

// --- Reading model lists ---

test("an openai style model list is read", () => {
    const models = P.parseModelList({ data: [{ id: "a" }, { id: "b" }] });
    assert.deepStrictEqual(models.map((m) => m.id), ["a", "b"]);
});

test("an ollama style model list is read", () => {
    const models = P.parseModelList({ models: [{ name: "gemma3:12b" }] });
    assert.strictEqual(models[0].id, "gemma3:12b");
});

test("free models are identified from openrouter prices", () => {
    const payload = {
        data: [
            { id: "paid/model", pricing: { prompt: "0.0000015", completion: "0.000006" } },
            { id: "free/model:free", pricing: { prompt: "0", completion: "0" } },
        ],
    };
    const all = P.parseModelList(payload);
    assert.strictEqual(all.find((m) => m.id === "paid/model").free, false);
    assert.strictEqual(all.find((m) => m.id === "free/model:free").free, true);

    const freeOnly = P.parseModelList(payload, { freeOnly: true });
    assert.strictEqual(freeOnly.length, 1);
    assert.strictEqual(freeOnly[0].id, "free/model:free");
});

test("asking for free models when none are free shows everything instead of nothing", () => {
    const payload = { data: [{ id: "paid", pricing: { prompt: "1", completion: "1" } }] };
    const freeOnly = P.parseModelList(payload, { freeOnly: true });
    assert.strictEqual(freeOnly.length, 1, "an empty list would be useless to the reader");
});

test("a junk model list gives an empty array rather than throwing", () => {
    [null, undefined, 42, "text", {}].forEach((value) => {
        assert.deepStrictEqual(P.parseModelList(value), []);
    });
});

// --- Error messages ---

test("failures are explained in terms of what to do next", () => {
    const provider = P.getProvider("openrouter");
    assert.ok(/key/i.test(P.describeFailure(401, "", provider)));
    assert.ok(/model name/i.test(P.describeFailure(404, "", provider)));
    assert.ok(/rate limit/i.test(P.describeFailure(429, "", provider)));
    assert.ok(/free model/i.test(P.describeFailure(402, "", provider)));
    assert.ok(/their end/i.test(P.describeFailure(503, "", provider)));
});

test("the phone and localhost trap is explained", () => {
    const hint = P.localReachabilityHint("http:", "192.168.1.40", false);
    assert.ok(/phone/i.test(hint));
    assert.ok(/localhost means the phone/i.test(hint));
});

test("no hint is given when the bridge is already running", () => {
    assert.strictEqual(P.localReachabilityHint("https:", "example.com", true), "");
});

// --- IDs ---

test("ids are always a fixed length", () => {
    for (let i = 0; i < 20000; i += 1) {
        assert.strictEqual(Ids.generateId().length, Ids.ID_LENGTH);
    }
});

test("ids contain only safe characters", () => {
    for (let i = 0; i < 2000; i += 1) {
        assert.match(Ids.generateId(), /^[0-9a-z]+$/);
    }
});

test("ids do not repeat across many draws", () => {
    const seen = new Set();
    for (let i = 0; i < 50000; i += 1) seen.add(Ids.generateId());
    assert.strictEqual(seen.size, 50000);
});

test("an id already in use is never handed out again", () => {
    const taken = new Set(["aaaaaaaaaaaa"]);
    for (let i = 0; i < 500; i += 1) {
        assert.notStrictEqual(Ids.generateUniqueId(taken), "aaaaaaaaaaaa");
    }
});

test("chat ids are recognisable and opaque", () => {
    const id = Ids.createChatId();
    assert.ok(Ids.isChatId(id));
    // No dashes, because splitting a chat id on dashes to guess which characters
    // it belonged to is what misfiled the chat history in the first place.
    assert.ok(!id.includes("-"));
});

// --- Escaping ---

test("html in a character name is turned into text", () => {
    const escaped = E.escapeHtml('<img src=x onerror="alert(1)">');
    assert.ok(!escaped.includes("<img"));
    assert.ok(escaped.includes("&lt;img"));
});

test("quotes are escaped so an attribute cannot be broken out of", () => {
    const escaped = E.escapeAttribute('" onload="bad()');
    assert.ok(!escaped.includes('"'));
});

test("a javascript url is refused", () => {
    assert.strictEqual(E.safeImageUrl("javascript:alert(1)"), "");
    assert.strictEqual(E.safeImageUrl("JaVaScRiPt:alert(1)"), "");
});

test("a data url for a script is refused but an image is allowed", () => {
    assert.strictEqual(E.safeImageUrl("data:text/html;base64,PHNjcmlwdD4="), "");
    assert.ok(E.safeImageUrl("data:image/png;base64,iVBORw0KGgo=").length > 0);
});

test("an ordinary image path is allowed", () => {
    assert.strictEqual(E.safeImageUrl("assets/logo.svg"), "assets/logo.svg");
    assert.ok(E.safeImageUrl("https://example.com/a.png").length > 0);
});

test("an initial is taken safely even from an odd name", () => {
    assert.strictEqual(E.initial("Saki"), "S");
    assert.strictEqual(E.initial(""), "?");
    assert.strictEqual(E.initial(null), "?");
    assert.strictEqual(E.initial("<b>x"), "&lt;");
});

// --- Picture sizing ---

test("a large picture is scaled down and keeps its shape", () => {
    const fitted = Img.fitWithin(4000, 3000, 512);
    assert.strictEqual(fitted.width, 512);
    assert.strictEqual(fitted.height, 384);
});

test("a picture already small enough is left alone", () => {
    const fitted = Img.fitWithin(200, 150, 512);
    assert.deepStrictEqual(fitted, { width: 200, height: 150 });
});

test("a very tall picture is limited by its height", () => {
    const fitted = Img.fitWithin(100, 5000, 512);
    assert.strictEqual(fitted.height, 512);
    assert.ok(fitted.width >= 1);
});

test("data url size is estimated close to the real byte count", () => {
    // "AAAA" in base64 is three bytes.
    assert.strictEqual(Img.estimateDataUrlBytes("data:image/png;base64,AAAA"), 3);
    assert.strictEqual(Img.estimateDataUrlBytes(""), 0);
    assert.strictEqual(Img.estimateDataUrlBytes(null), 0);
});

// --- Making a provider's error readable ---
//
// The case that prompted this was a real Gemini rate limit reply: about two thousand
// characters of nested JSON, which went straight into a banner, filled the screen and
// pushed the message box out of view.

const REAL_RATE_LIMIT = new Error(JSON.stringify({
    error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details.\nPlease retry in 48.424312416s.",
        status: "RESOURCE_EXHAUSTED",
        details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{
                quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                quotaDimensions: { model: "gemini-3.6-flash", location: "global" },
                quotaValue: "20",
            }] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "48s" },
        ],
    },
}));

test("a real rate limit becomes one readable sentence", () => {
    const out = P.describeProviderError(REAL_RATE_LIMIT, P.getProvider("gemini"));
    assert.strictEqual(out.kind, "rate-limited");
    assert.ok(out.short.length < 200, `should be short, was ${out.short.length} characters`);
    assert.ok(out.short.includes("gemini-3.6-flash"));
    assert.ok(out.short.includes("20"), "it should say what the allowance is");
    assert.ok(/48 seconds/.test(out.short), "and how long to wait");
    assert.ok(!out.short.includes("{"), "no json should reach the reader");
});

test("a long wait is given in minutes rather than seconds", () => {
    const error = new Error(JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "RetryInfo", retryDelay: "600s" }] } }));
    const out = P.describeProviderError(error, P.getProvider("gemini"));
    assert.ok(/10 minutes/.test(out.short), out.short);
});

test("a rejected key is reported as a key problem", () => {
    const out = P.describeProviderError(new Error(JSON.stringify({ error: { code: 401 } })), P.getProvider("groq"));
    assert.strictEqual(out.kind, "bad-key");
    assert.ok(/key/i.test(out.short));
});

test("an unknown model is reported as a model problem", () => {
    const out = P.describeProviderError(new Error(JSON.stringify({ error: { code: 404 } })), P.getProvider("gemini"));
    assert.strictEqual(out.kind, "no-such-model");
});

test("a provider outage is not blamed on your setup", () => {
    const out = P.describeProviderError(new Error(JSON.stringify({ error: { code: 503 } })), P.getProvider("gemini"));
    assert.strictEqual(out.kind, "provider-down");
    assert.ok(/their end/i.test(out.short));
    assert.ok(/nothing is wrong with your setup/i.test(out.advice));
});

test("an error that is not json still produces something readable", () => {
    const out = P.describeProviderError(new Error("Failed to fetch"), P.getProvider("gemini"));
    assert.ok(out.short.includes("Failed to fetch"));
    assert.ok(out.short.length < 250);
});

test("junk input does not throw", () => {
    [null, undefined, 42, {}, new Error("")].forEach((value) => {
        const out = P.describeProviderError(value, P.getProvider("gemini"));
        assert.strictEqual(typeof out.short, "string");
    });
});

test("the unavailable line reads as the character speaking", () => {
    const line = P.characterUnavailableLine({
        characterName: "Rem", userName: "Kash", description: "Google Gemini has hit its free usage limit.",
    });
    assert.ok(line.startsWith("*Rem is unavailable right now, Kash.*"), line);
    assert.ok(/Settings/.test(line), "it should say where to look");
});

test("the unavailable line copes with no name for you", () => {
    const line = P.characterUnavailableLine({ characterName: "Rem", description: "Something went wrong." });
    assert.ok(line.includes("Rem"));
    assert.ok(!line.includes("undefined"));
});

// --- Providers that will not accept requests from a web page ---
//
// A browser refuses a cross domain request unless the API sends back headers saying it is
// allowed. Gemini and OpenRouter do. NVIDIA NIM does not, and has been asked to for years
// without it happening, so a request from the page is blocked before it is even sent. Those
// have to go through a proxy.

test("every provider states whether a browser can call it directly", () => {
    P.listProviders().forEach((provider) => {
        const policy = P.corsPolicy(provider);
        assert.ok(['direct', 'proxy', 'try-direct'].includes(policy),
            `${provider.id} has an unknown policy: ${policy}`);
    });
});

test("nvidia is known to need a proxy", () => {
    assert.strictEqual(P.alwaysNeedsProxy(P.getProvider('nvidia')), true);
});

test("gemini and openrouter do not need one", () => {
    assert.strictEqual(P.alwaysNeedsProxy(P.getProvider('gemini')), false);
    assert.strictEqual(P.alwaysNeedsProxy(P.getProvider('openrouter')), false);
});

test("local providers are never proxied, since a proxy could not reach them", () => {
    assert.strictEqual(P.corsPolicy(P.getProvider('ollama')), 'direct');
    assert.strictEqual(P.corsPolicy(P.getProvider('lmstudio')), 'direct');
});

test("the uncertain ones are allowed to try directly first", () => {
    ['groq', 'cerebras', 'mistral', 'custom'].forEach((id) => {
        assert.strictEqual(P.canRetryThroughProxy(P.getProvider(id)), true, id);
    });
});

test("a proxied request keeps the target in a header and the key intact", () => {
    const built = P.buildRequest({
        provider: P.getProvider('nvidia'),
        url: 'https://integrate.api.nvidia.com/v1/chat/completions',
        proxyUrl: 'https://example.netlify.app/api/proxy',
        viaProxy: true,
        headers: { Authorization: 'Bearer nvapi-secret', 'Content-Type': 'application/json' },
    });

    assert.strictEqual(built.url, 'https://example.netlify.app/api/proxy');
    assert.strictEqual(built.headers['X-Cast-Target'], 'https://integrate.api.nvidia.com/v1/chat/completions');
    assert.strictEqual(built.headers.Authorization, 'Bearer nvapi-secret', 'the key must survive');
    assert.strictEqual(built.viaProxy, true);
});

test("a direct request is left completely alone", () => {
    const built = P.buildRequest({
        provider: P.getProvider('gemini'),
        url: 'https://generativelanguage.googleapis.com/v1beta/models',
        proxyUrl: 'https://example.netlify.app/api/proxy',
        viaProxy: false,
        headers: { Authorization: 'Bearer k' },
    });
    assert.strictEqual(built.url, 'https://generativelanguage.googleapis.com/v1beta/models');
    assert.strictEqual(built.headers['X-Cast-Target'], undefined);
    assert.strictEqual(built.viaProxy, false);
});

test("asking for a proxy without one configured falls back to going direct", () => {
    const built = P.buildRequest({
        provider: P.getProvider('nvidia'),
        url: 'https://integrate.api.nvidia.com/v1/models',
        proxyUrl: '',
        viaProxy: true,
        headers: {},
    });
    assert.strictEqual(built.viaProxy, false);
    assert.strictEqual(built.url, 'https://integrate.api.nvidia.com/v1/models');
});

test("the proxy address is worked out from where the app is served", () => {
    assert.strictEqual(P.defaultProxyUrl('https://cast.netlify.app', 'https:'), 'https://cast.netlify.app/api/proxy');
    assert.strictEqual(P.defaultProxyUrl('http://localhost:3000', 'http:'), 'http://localhost:3000/api/proxy');
});

test("there is no proxy when the file is opened directly", () => {
    // There is no server, so there is nothing to run a function.
    assert.strictEqual(P.defaultProxyUrl('null', 'file:'), '');
    assert.strictEqual(P.defaultProxyUrl('', 'file:'), '');
});

test("a browser block is told apart from an ordinary failure", () => {
    // A blocked request arrives as a TypeError with no status, because there was never a
    // response. That is the signature worth retrying through a proxy.
    assert.strictEqual(P.looksBlockedByBrowser(new TypeError('Failed to fetch')), true);
    assert.strictEqual(P.looksBlockedByBrowser(new TypeError('NetworkError when attempting to fetch resource.')), true);
    assert.strictEqual(P.looksBlockedByBrowser(new TypeError('Load failed')), true);
    assert.strictEqual(P.looksBlockedByBrowser(null), false);
    assert.strictEqual(P.looksBlockedByBrowser(new Error('rate limited')), false);
});
