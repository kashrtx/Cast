// Constants and provider plumbing.
//
// This section used to hard code three providers with a separate function for
// each one. It now works from the registry in src/providers.js, so adding a
// provider is a config change rather than new code, and every service that
// speaks the OpenAI chat format shares one code path.

const STORAGE_KEYS = {
    API_KEY: "gemini_api_key",
    CHARACTERS: "gemini_characters",
    CHATS: "gemini_chats",
    SETTINGS: "gemini_settings",
    PERSONAL_CONTEXT: "gemini_personal_context",
    CHAT_HISTORY: "gemini_chat_history",
    LAST_ACTIVE_CHATS: "gemini_last_active_chats",
};
// The storage key names are deliberately unchanged. Renaming them would have
// stranded the data of anyone already using the app.

const VERSION = CastBrand.appVersion;

// App Settings
let appSettings = {
    provider: "gemini",
    // Per provider, so you can set several up and switch without pasting a key
    // again. The old single modelVersion and key fields are migrated on load.
    apiKeys: {},
    models: {},
    baseUrls: {},
    includeKeyInBackups: false,
    // Left empty so it is worked out from the address the app is served from. Set it by hand if
    // your proxy lives somewhere else.
    proxyUrl: '',
    // Off by default. Long chats work exactly as before until this is switched on.
    memoryCompaction: false,
    memory: {},
    temperature: 1.0,
    enhancedContextTokens: 4096,
    conversationTokens: 4096,
    maxTokens: 4096,
};

// App State
let state = {
    apiKey: "",
    characters: [],
    chats: {},
    chatHistory: {},
    usableChatHistory: {},
    orphanedChats: [],
    chatMembers: {},
    activeCharacters: [],
    activeChat: null,
    selectedCharacters: [],
    genaiClient: null,
    activeProvider: null,
    isApiConnected: false,
    personalContext: {
        name: "",
        personality: "",
        context: ""
    },
    lastActiveChats: {},
    isResponseInProgress: false,
    // The characters page search. Kept separate from the chat list search below, because sharing
    // one field meant typing in either box filtered both pages.
    characterSearchTerm: "",
    sidebarSearchTerm: "",
    characterSortOrder: "createdAt_desc",
    pendingResponses: {},
    pictureCache: {},
    backupState: null,
    backupSaveTimer: null,
    membershipSaveTimer: null,
    logSaveTimer: null,
    chatMemory: {},
    isCompacting: false,
    activityLog: [],
    pendingProfilePicture: null,
    pendingEditProfilePicture: null,
    modelSuggestions: {},
};

// --- Provider helpers ---

function getCurrentProvider() {
    return CastProviders.getProvider(appSettings.provider).id;
}

function getProviderConfig(providerId) {
    return CastProviders.getProvider(providerId || getCurrentProvider());
}

function getProviderDisplayName(providerId) {
    return getProviderConfig(providerId).label;
}

function getApiKeyFor(providerId) {
    const id = providerId || getCurrentProvider();
    const key = (appSettings.apiKeys && appSettings.apiKeys[id]) || "";
    // Gemini used to live in its own slot, so fall back to it.
    if (!key && id === "gemini") return state.apiKey || "";
    return key;
}

function setApiKeyFor(providerId, value) {
    if (!appSettings.apiKeys) appSettings.apiKeys = {};
    appSettings.apiKeys[providerId] = value;
    if (providerId === "gemini") {
        state.apiKey = value;
        setStoredItem(STORAGE_KEYS.API_KEY, value);
    }
}

// The model is whatever you typed. Nothing here rewrites it except mapping a
// retired Gemini name onto its replacement, and even then an unfamiliar name is
// always left alone.
function getModelFor(providerId) {
    const id = providerId || getCurrentProvider();
    const configured = (appSettings.models && appSettings.models[id]) || "";
    const trimmed = String(configured).trim();
    if (trimmed) {
        return id === "gemini" ? CastProviders.migrateModelName(trimmed) : trimmed;
    }
    return getProviderConfig(id).defaultModel || "";
}

function getBaseUrlFor(providerId) {
    return CastProviders.resolveBaseUrl(getProviderConfig(providerId), appSettings);
}

function getTokenLimit(value, fallback = 4096) {
    return CastProviders.resolveTokenLimit(value, fallback);
}

function getConversationTokenLimit() {
    return getTokenLimit(appSettings.conversationTokens || appSettings.maxTokens);
}

function isProviderConfigured(providerId) {
    const provider = getProviderConfig(providerId);
    const model = getModelFor(provider.id);

    if (provider.needsKey && !getApiKeyFor(provider.id)) return false;
    if (provider.kind !== CastProviders.KIND.GEMINI && !getBaseUrlFor(provider.id)) return false;

    // LM Studio can work out its own model from the server, so a blank model is
    // acceptable there. Everywhere else a model name is required.
    if (!model && provider.id !== "lmstudio") return false;

    return true;
}

function getProviderConfigurationMessage(providerId) {
    const provider = getProviderConfig(providerId);

    if (provider.needsKey && !getApiKeyFor(provider.id)) {
        return `Add your ${provider.label} API key in Settings to start chatting.`;
    }
    if (!getBaseUrlFor(provider.id) && provider.kind !== CastProviders.KIND.GEMINI) {
        return `Set the ${provider.label} address in Settings.`;
    }
    if (!getModelFor(provider.id)) {
        return `Type a model name for ${provider.label} in Settings.`;
    }
    return `Finish setting up ${provider.label} in Settings.`;
}

function getLocalProviderBridgeHint(targetUrl) {
    const bridgeActive = Boolean(window.__GCRP_LOCAL_AI_BRIDGE__ && window.__GCRP_LOCAL_AI_BRIDGE__.active);
    return CastProviders.localReachabilityHint(
        window.location.protocol,
        window.location.hostname,
        bridgeActive,
        targetUrl || getBaseUrlFor()
    );
}

function isLocalProvider(providerId) {
    const id = providerId || getCurrentProvider();
    return id === "ollama" || id === "lmstudio";
}

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

    const attempt = async (viaProxy) => {
        const built = CastProviders.buildRequest({
            provider,
            url,
            proxyUrl,
            viaProxy,
            headers: (options && options.headers) || {},
        });
        lastRequestUsedProxy = built.viaProxy;
        const response = await fetch(built.url, Object.assign({}, options, { headers: built.headers }));
        // Carried on the response so the code reading it knows which route it took.
        try { response.viaProxy = built.viaProxy; } catch (error) { /* some browsers seal this */ }
        return response;
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

// --- The one adapter that covers every OpenAI compatible service ---

async function callOpenAiCompatible(messages, maxOutputTokens, providerId) {
    const provider = getProviderConfig(providerId);
    const baseUrl = getBaseUrlFor(provider.id);
    let model = getModelFor(provider.id);

    // LM Studio often runs with a single loaded model and people leave the name
    // as the placeholder, so ask the server what it has.
    if (provider.id === "lmstudio" && (!model || model === "local-model")) {
        model = await resolveModelFromServer(provider.id) || model;
    }

    const response = await fetchProvider(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: CastProviders.buildHeaders(provider, getApiKeyFor(provider.id)),
        body: JSON.stringify(CastProviders.buildChatBody({
            model,
            messages,
            maxTokens: getTokenLimit(maxOutputTokens),
            temperature: appSettings.temperature,
            stream: false,
        })),
    }, provider.id);

    if (!response.ok) {
        const body = await readErrorBody(response);

        // If this went through the proxy, the failure may be the proxy rather than the provider.
        if (response.viaProxy || lastRequestUsedProxy) {
            const proxyProblem = describeProxyFailure(response, body, getProxyUrl());
            if (proxyProblem) {
                recordActivityIfReady(CastLog.KINDS.PROXY_FAILED, proxyProblem);
                throw new Error(proxyProblem);
            }
        }

        throw new Error(describeProviderFailure(response.status, body, provider));
    }

    const payload = await response.json();
    // Reasoning and reply are separated here, for every provider, in one place.
    return CastThinking.extractFromResponse(payload);
}

// Ollama's own endpoint. Kept because it accepts options the OpenAI shaped one
// does not, including switching reasoning off outright on models that support it.
async function callOllamaNative(messages, maxOutputTokens) {
    const provider = getProviderConfig("ollama");
    const baseUrl = getBaseUrlFor("ollama");

    const response = await fetchProvider(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: getModelFor("ollama"),
            messages,
            stream: false,
            // Ollama understands this directly. On a model that reasons, this
            // turns it off at the source rather than asking it nicely.
            think: false,
            options: {
                temperature: appSettings.temperature,
                num_predict: getTokenLimit(maxOutputTokens),
            },
        }),
    }, "ollama");

    if (!response.ok) {
        throw new Error(CastProviders.describeFailure(response.status, await readErrorBody(response), provider));
    }

    return CastThinking.extractFromResponse(await response.json());
}

// Asks a provider what models it currently has. Used to fill the suggestion list
// under the model field, so the suggestions are the real catalogue of the day
// rather than a list baked in when this was written.
async function fetchModelSuggestions(providerId, options) {
    const provider = getProviderConfig(providerId);
    if (!provider.modelsPath) {
        throw new Error(`${provider.label} does not publish a model list. Type a name from their website.`);
    }

    const baseUrl = getBaseUrlFor(provider.id);
    if (!baseUrl) {
        throw new Error(`Set the ${provider.label} address first.`);
    }

    if (provider.needsKey && !getApiKeyFor(provider.id)) {
        throw new Error(`Add your ${provider.label} key first, then the list can be loaded.`);
    }

    let url = `${baseUrl}${provider.modelsPath}`;
    const headers = CastProviders.buildHeaders(provider, getApiKeyFor(provider.id));

    // Gemini wants the key in the query string, not a header, and sending an
    // Authorization header to it causes the request to be rejected.
    if (provider.kind === CastProviders.KIND.GEMINI) {
        url += `?key=${encodeURIComponent(getApiKeyFor("gemini"))}&pageSize=200`;
        delete headers.Authorization;
    }

    const response = await fetchProvider(url, { headers }, provider.id);

    if (!response.ok) {
        const body = await readErrorBody(response);
        if (lastRequestUsedProxy) {
            const proxyProblem = describeProxyFailure(response, body, getProxyUrl());
            if (proxyProblem) {
                recordActivityIfReady(CastLog.KINDS.PROXY_FAILED, proxyProblem);
                throw new Error(proxyProblem);
            }
        }
        throw new Error(describeProviderFailure(response.status, body, provider));
    }

    const payload = await response.json();
    const freeOnly = Boolean(options && options.freeOnly) && provider.supportsFreeFilter;
    const models = CastProviders.parseModelList(payload, { freeOnly });

    if (!models.length) {
        throw new Error(`${provider.label} replied but listed no usable chat models. Type a name from their website.`);
    }

    return models;
}

async function resolveModelFromServer(providerId) {
    try {
        const models = await fetchModelSuggestions(providerId);
        return models.length ? models[0].id : "";
    } catch (error) {
        return "";
    }
}

// --- Connecting ---

async function initializeAIProvider({ showErrors = true } = {}) {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);

    if (!isProviderConfigured(providerId)) {
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(getProviderConfigurationMessage(providerId));
        return false;
    }

    try {
        if (provider.kind === CastProviders.KIND.GEMINI) {
            const { GoogleGenAI } = await import("https://esm.run/@google/genai");
            state.genaiClient = new GoogleGenAI({ apiKey: getApiKeyFor("gemini") });

            const result = await state.genaiClient.models.generateContent({
                model: getModelFor("gemini"),
                contents: "Reply with OK.",
                config: CastProviders.buildGeminiConfig({
                    model: getModelFor("gemini"),
                    maxTokens: 256,
                    temperature: appSettings.temperature,
                }),
            });
            const checked = CastThinking.extractFromResponse(result);
            console.log("Gemini reachable. Test reply:", checked.reply.substring(0, 40));
        } else {
            state.genaiClient = null;
            const probe = [{ role: "user", content: "Reply with OK." }];
            if (provider.kind === CastProviders.KIND.OLLAMA) {
                await callOllamaNative(probe, 256);
            } else {
                await callOpenAiCompatible(probe, 256, provider.id);
            }
            console.log(`${provider.label} reachable.`);
        }

        state.activeProvider = providerId;
        state.isApiConnected = true;
        checkApiKey();
        return true;
    } catch (error) {
        console.error(`Could not connect to ${provider.label}:`, error);
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(error.message);
        checkApiKey();
        return false;
    }
}

// Older call sites used this name.
async function initializeGeminiAPI(options) {
    return initializeAIProvider(options);
}

async function ensureAIProviderReady() {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);
    const isGemini = provider.kind === CastProviders.KIND.GEMINI;

    if (state.isApiConnected && state.activeProvider === providerId && (!isGemini || state.genaiClient)) {
        return true;
    }

    // Say what is actually wrong before trying anything.
    if (!isProviderConfigured(providerId)) {
        throw new Error(getProviderConfigurationMessage(providerId));
    }

    // Everything needed is present, so reconnect without making a test request.
    //
    // This used to call the full connect routine, which sends a short test message
    // first. That doubled the number of requests per reply and meant a rate limit on
    // the test call was reported as "Finish setting up Google Gemini in Settings",
    // which sent you to a settings screen where nothing was wrong. The real request
    // below will report its own failure honestly.
    if (isGemini) {
        try {
            const { GoogleGenAI } = await import("https://esm.run/@google/genai");
            state.genaiClient = new GoogleGenAI({ apiKey: getApiKeyFor("gemini") });
        } catch (error) {
            throw new Error(`Could not load the Google library: ${error.message}`);
        }
    } else {
        state.genaiClient = null;
    }

    state.activeProvider = providerId;
    state.isApiConnected = true;
    checkApiKey();
    return true;
}

// --- Sending ---

// A single prompt with no conversation around it, used for character context
// enhancement and for the fallback path.
async function callAIText(prompt, maxOutputTokens) {
    await ensureAIProviderReady();

    const provider = getProviderConfig();

    if (provider.kind === CastProviders.KIND.GEMINI) {
        const result = await state.genaiClient.models.generateContent({
            model: getModelFor("gemini"),
            contents: prompt,
            config: CastProviders.buildGeminiConfig({
                model: getModelFor("gemini"),
                maxTokens: getTokenLimit(maxOutputTokens),
                temperature: appSettings.temperature,
            }),
        });
        return finishReply(CastThinking.extractFromResponse(result));
    }

    const messages = [{ role: "user", content: prompt }];
    if (provider.kind === CastProviders.KIND.OLLAMA) {
        return finishReply(await callOllamaNative(messages, maxOutputTokens));
    }
    return finishReply(await callOpenAiCompatible(messages, maxOutputTokens, provider.id));
}

// A full conversation.
async function callAIChat(messages, maxOutputTokens) {
    await ensureAIProviderReady();

    const provider = getProviderConfig();

    if (provider.kind === CastProviders.KIND.OLLAMA) {
        return finishReply(await callOllamaNative(messages, maxOutputTokens));
    }
    if (provider.kind === CastProviders.KIND.GEMINI) {
        const flattened = messages
            .map(message => `${String(message.role).toUpperCase()}: ${message.content}`)
            .join("\n\n");
        return callAIText(flattened, maxOutputTokens);
    }
    return finishReply(await callOpenAiCompatible(messages, maxOutputTokens, provider.id));
}

// The last check before a reply is used anywhere.
//
// If the model produced only its reasoning, we refuse it rather than passing the
// reasoning off as something the character said. That is the exact failure the
// old code had, where a message could be saved containing nothing but the
// model's working out.
function finishReply(extracted) {
    const verdict = CastThinking.verifyReply(extracted);
    if (!verdict.ok) {
        throw new Error(verdict.message);
    }
    return verdict.reply;
}

// Older name, still used in a few places.
async function callGeminiAPI(prompt) {
    return callAIText(prompt, appSettings.conversationTokens || appSettings.maxTokens);
}

async function callGeminiText(prompt, maxOutputTokens) {
    return callAIText(prompt, maxOutputTokens);
}

function convertGeminiHistoryToChatMessages(history) {
    return history.map(entry => ({
        role: entry.role === "model" ? "assistant" : "user",
        content: (entry.parts || []).map(part => part.text || "").join("\n"),
    })).filter(message => message.content.trim());
}

// Builds the message list for a provider that speaks the OpenAI shape.
//
// Note what is no longer here. The old version appended an instruction telling
// the model not to think, both to the system prompt and to the per turn
// instructions. It never worked, because reasoning is part of how a model runs
// and not something a prompt can switch off, and it leaked meta instructions
// into the character's persona. Reasoning is now handled by asking the API
// properly and by separating it from the reply when it comes back.
function buildLocalChatMessages(character, history, instructions) {
    const systemPrompt = prepareContextForAPI(character, [], [character]);
    return [
        { role: "system", content: systemPrompt },
        ...convertGeminiHistoryToChatMessages(history),
        { role: "user", content: instructions },
    ];
}
// Helper functions

// IDs now come from the ids module. The old version sliced a random number into
// a string, which occasionally produced an ID only one or two characters long,
// and never checked whether an ID was already in use.
const generateUniqueId = () => {
    const taken = new Set();
    (state.characters || []).forEach(c => { if (c && c.id) taken.add(c.id); });
    Object.keys(state.chats || {}).forEach(chatId => {
        taken.add(chatId);
        const body = state.chats[chatId];
        if (Array.isArray(body)) body.forEach(m => { if (m && m.id) taken.add(m.id); });
    });
    return CastIds.generateUniqueId(taken);
};

// The single store every read and write goes through.
const castStore = CastStorage.createStore();

// Kept with the same names and shapes as before so the rest of the app did not
// need rewriting. The behaviour underneath is different in two ways that matter.
// Reading never throws, and writing tells the truth about whether it worked.
const getStoredItem = (key, defaultValue = null) => {
    const result = castStore.read(key, CastStorage.SHAPES[key]);
    if (result.missing && defaultValue !== null && defaultValue !== undefined) {
        return defaultValue;
    }
    if (result.problem) {
        recordStorageProblem(result.problem);
    }
    return result.value;
};

// Every failed write is now surfaced instead of being swallowed. Running out of
// room used to mean messages silently disappeared on the next reload, which was
// the single biggest cause of chat history feeling unreliable.
const setStoredItem = (key, value) => {
    const result = castStore.write(key, value);
    if (!result.ok) {
        reportSaveFailure(key, result);
        return false;
    }
    noteDataChanged();
    return true;
};

// Problems found while loading, shown to the reader once start up has finished
// rather than thrown away into the console.
let storageProblems = [];

function recordStorageProblem(problem) {
    if (!problem) return;
    storageProblems.push(problem);
    console.warn(`Storage problem on ${problem.key}: ${problem.detail}`);
    recordActivityIfReady(CastLog.KINDS.DATA_SET_ASIDE, `${problem.key}: ${problem.detail}`);
}

function reportSaveFailure(key, result) {
    recordActivityIfReady(CastLog.KINDS.SAVE_FAILED, `${key} could not be written: ${result.reason}`);

    if (result.reason === "quota") {
        showError("There is no room left in this browser's storage, so that change was not saved. Open Settings and use Storage to see what is taking up space, then save a backup before clearing anything.");
        return;
    }
    if (result.reason === "verify-failed") {
        showError("This browser accepted the change but did not keep it, which usually means storage is full. Save a backup now to be safe.");
        return;
    }
    console.error(`Could not save ${key}: ${result.reason}`);
    showError("That change could not be saved. Your existing data is untouched.");
}

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded - initializing app");

    // Each start up step runs inside its own guard. This is the change that
    // stops the app coming up blank. Previously these ran one after another with
    // nothing catching a failure, so an error in the first step meant the views,
    // the character list and every button were never set up, and the page looked
    // like all the data had been deleted when it was actually still there.
    // Installed first, so anything that fails during start up is also reported.
    try { installFailsafeErrorReporting(); } catch (error) { console.error(error); }

    const bootFailures = [];
    const bootStep = (name, work) => {
        try {
            work();
            return true;
        } catch (error) {
            console.error(`Start up step "${name}" failed:`, error);
            recordActivityIfReady(CastLog.KINDS.STARTUP_FAILED, `${name}: ${error.message}`);
            bootFailures.push({ name, error });
            return false;
        }
    };

    bootStep('load saved data', loadStoredData);
    bootStep('read backup reminder state', loadBackupState);

    // Pictures are read before the first render, otherwise every avatar would
    // flash blank and then fill in. Failure here is not fatal, since the lists
    // fall back to the character's initial.
    try {
        await preloadPictures();
    } catch (error) {
        console.warn("Pictures could not be read on start up:", error);
    }

    bootStep('measure the header', trackHeaderHeight);
    bootStep('show the chat view', () => changeView('chat'));
    bootStep('list characters', updateCharacterLists);
    bootStep('connect buttons', setupEventListeners);
    bootStep('connect direct buttons', setupDirectListeners);
    bootStep('check the provider', checkApiKey);
    bootStep('set up the sidebar', initializeSidebar);
    bootStep('restore the sidebar state', setupSidebarCollapse);
    bootStep('set up the navigation', setupSlidingNav);
    bootStep('set up search', setupSearchBoxes);
    bootStep('set up the edit panel', setupEditModalExtras);
    bootStep('apply the chat layout', setupChatLayoutChoice);
    bootStep('apply the theme', setupThemeChoice);
    bootStep('draw the home screen', () => renderChatHome(''));
    bootStep('set up settings', initializeModelSettings);
    bootStep('show last backup time', updateLastBackupStatus);
    bootStep('start the reminder timer', startBackupReminderTimer);

    // Move any pictures still stored with the characters into the picture store.
    // Runs after the interface is up, so it never delays the app appearing.
    migratePicturesIfNeeded().catch(error => {
        console.warn("Pictures could not be moved this time:", error);
    });

    // Tell the reader about anything odd found while loading, now that there is
    // an interface to tell them in. Nothing was deleted, so the tone is
    // informational rather than alarming.
    if (storageProblems.length) {
        const keys = storageProblems.map(problem => problem.key).join(', ');
        showError(
            `Some saved data could not be read (${keys}) so it was set aside rather than deleted, and everything else loaded normally. Your other characters and chats are unaffected.`
        );
    }

    if (bootFailures.length) {
        console.error(`${bootFailures.length} start up steps failed.`, bootFailures);
        showError(
            `Part of the app did not start correctly (${bootFailures.map(f => f.name).join(', ')}). Your data is safe. Reloading the page usually clears it.`
        );
    }

    // Connect to the provider last, since it involves the network and should
    // never hold up the interface.
    if (isProviderConfigured()) {
        try {
            const connected = await initializeAIProvider({ showErrors: false });
            if (connected) {
                console.log(`${getProviderDisplayName()} connected.`);
            }
        } catch (error) {
            console.error("Could not connect to the provider on start up:", error);
        }
    }
});

// Moves pictures out of the crowded text storage and into the picture store.
//
// This is what makes an old backup work without any effort from you. The file
// still has its pictures embedded, they get pulled out on load, and the character
// record is left with a marker instead of megabytes of text.
async function migratePicturesIfNeeded() {
    const needsMoving = (state.characters || []).some(
        character => character && typeof character.profilePicture === 'string'
            && character.profilePicture.indexOf('data:') === 0
    );
    if (!needsMoving) return;

    console.log("Moving profile pictures into their own store.");
    const migration = await CastImages.migrateEmbeddedPictures(state.characters);

    if (!migration.moved) return;

    state.characters = migration.characters;
    const saved = migration.bytesBefore - migration.bytesAfter;
    const wrote = setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    if (wrote) {
        console.log(`Moved ${migration.moved} pictures and saved ${formatBytes(saved)}.`);
        await preloadPictures();
        updateCharacterLists();
        updateSidebarCharacters();
        updateStoragePanel();
        if (saved > 100 * 1024) {
            showSuccess(`Tidied up ${migration.moved} profile pictures and freed ${formatBytes(saved)} of space.`, 5000);
        }
    }
}

// Reads the pictures once so the lists can draw without waiting on the database
// for every row.
//
// It also clears any hasPicture flag whose picture is genuinely missing. A file
// written by version 2.0.0 claimed pictures it did not contain, because the export
// did not fetch them from their store. Leaving the flag set makes the app look
// like it is still loading something that will never arrive.
async function preloadPictures() {
    try {
        state.pictureCache = await CastImages.getAllPictures();
    } catch (error) {
        console.warn("Pictures could not be read:", error);
        state.pictureCache = {};
    }

    let corrected = 0;
    (state.characters || []).forEach(character => {
        if (!character || !character.hasPicture) return;
        const hasData = Boolean(state.pictureCache[character.id])
            || (typeof character.profilePicture === 'string' && character.profilePicture);
        if (!hasData) {
            delete character.hasPicture;
            corrected += 1;
        }
    });

    if (corrected) {
        console.log(`${corrected} characters were marked as having a picture that is not here. Showing their initial instead.`);
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);
    }
}

// Where the rest of the app asks for a character's picture.
function getCharacterPicture(character) {
    if (!character) return '';
    // A picture still embedded in the record, from before the move.
    if (typeof character.profilePicture === 'string' && character.profilePicture) {
        return character.profilePicture;
    }
    return (state.pictureCache && state.pictureCache[character.id]) || '';
}

// Formatting a timestamp for reading.
//
// There was a formatter already, but it was declared inside another function, so it was
// not reachable from anywhere else. Calling it from the home screen threw a reference
// error, which stopped the home screen drawing at all and reported a start up failure.
function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    if (!timestamp || Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();

    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

    return `${date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${time}`;
}

// The home screen, shown when no chat is open.
//
// It used to be one line of grey text saying to pick someone. This shows who you have,
// what you last said to each other, and how much history there is, with the conversations
// you are part way through pulled to the front.
function renderChatHome(searchTerm) {
    const home = document.getElementById('chat-home');
    if (!home) return;

    const term = typeof searchTerm === 'string'
        ? searchTerm
        : (document.getElementById('home-search') || {}).value || '';

    const all = filterCharacters(state.characters || [], term);

    const countLabel = document.getElementById('home-count');
    if (countLabel) {
        const total = (state.characters || []).length;
        countLabel.textContent = term.trim()
            ? `${all.length} of ${total}`
            : `${total} ${total === 1 ? 'character' : 'characters'}`;
    }

    const providerLine = document.getElementById('home-provider');
    if (providerLine) {
        providerLine.textContent = `${getProviderDisplayName()}, ${getModelFor()}`;
    }

    const empty = document.getElementById('home-empty');
    const allSection = document.getElementById('home-all-section');
    const recentSection = document.getElementById('home-recent-section');

    if (!all.length) {
        if (empty) {
            empty.classList.remove('hidden');
            const message = empty.querySelector('p');
            if (message) {
                message.textContent = term.trim()
                    ? `Nobody matches "${term.trim()}".`
                    : 'No characters yet.';
            }
        }
        if (allSection) allSection.classList.add('hidden');
        if (recentSection) recentSection.classList.add('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');
    if (allSection) allSection.classList.remove('hidden');

    // Anyone with a conversation already going, most recent first.
    const withHistory = all
        .map(character => ({ character, at: getLastMessageTimestamp(character.id) }))
        .filter(entry => entry.at > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, 4);

    const recent = document.getElementById('home-recent');
    if (recentSection && recent) {
        if (withHistory.length && !term.trim()) {
            recentSection.classList.remove('hidden');
            recent.innerHTML = withHistory.map(entry => homeCard(entry.character, true)).join('');
        } else {
            recentSection.classList.add('hidden');
        }
    }

    const list = document.getElementById('home-all');
    if (list) {
        // Anyone already shown above is left out here, otherwise the same four appear twice
        // and it reads as though they are duplicated.
        const shownAbove = new Set(
            (recentSection && !recentSection.classList.contains('hidden'))
                ? withHistory.map(entry => entry.character.id)
                : []
        );
        const rest = all.filter(character => !shownAbove.has(character.id));

        const heading = document.querySelector('#home-all-section h3');
        if (heading) heading.textContent = shownAbove.size ? 'Everyone else' : 'Everyone';

        list.innerHTML = rest.map(character => homeCard(character, false)).join('');
        if (!rest.length) document.getElementById('home-all-section').classList.add('hidden');
        else document.getElementById('home-all-section').classList.remove('hidden');
    }

    // One handler for the whole grid rather than one per card.
    home.querySelectorAll('[data-open-character]').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-open-character');
            if (!id) return;
            state.selectedCharacters = [id];
            toggleCharacterSelection(id);
        });
    });
}

// One card on the home screen.
function homeCard(character, isRecent) {
    const safeName = CastEscape.escapeHtml(character.name);
    const picture = CastEscape.safeImageUrl(getCharacterPicture(character));

    const avatar = picture
        ? `<img src="${picture}" alt="${safeName}" loading="lazy" class="w-11 h-11 rounded-full object-cover flex-shrink-0">`
        : `<div class="w-11 h-11 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold flex-shrink-0">${CastEscape.initial(character.name)}</div>`;

    // How much has been said, and the last thing said.
    let messageCount = 0;
    let lastLine = '';
    Object.keys(state.chats || {}).forEach(chatId => {
        if (!chatBelongsToCharacter(chatId, character.id)) return;
        const body = state.chats[chatId];
        if (!Array.isArray(body)) return;
        body.forEach(message => {
            if (!message || message.isDeleted || message.isSystem || message.isTyping) return;
            messageCount += 1;
            if (typeof message.content === 'string' && message.content.trim()) {
                lastLine = message.content;
            }
        });
    });

    const preview = lastLine
        ? CastEscape.escapeHtml(lastLine.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90))
        : CastEscape.escapeHtml(String(character.userContext || '').replace(/\s+/g, ' ').trim().slice(0, 90));

    const when = getLastMessageTimestamp(character.id);
    const meta = messageCount
        ? `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}${when ? ` &middot; ${CastEscape.escapeHtml(formatDateTime(when))}` : ''}`
        : 'No messages yet';

    return `
        <button type="button" data-open-character="${CastEscape.escapeAttribute(character.id)}"
            class="text-left w-full bg-white border rounded-xl p-4 hover:shadow-md hover:border-primary/40 transition flex gap-3 items-start${isRecent ? ' border-primary/30' : ''}">
            ${avatar}
            <div class="min-w-0 flex-grow">
                <p class="font-semibold text-gray-800 truncate">${safeName}</p>
                <p class="text-sm text-gray-500 truncate">${preview || 'No description yet'}</p>
                <p class="text-xs text-gray-400 mt-1">${meta}</p>
            </div>
        </button>`;
}

// Says when a search is hiding some of the list, with a way to clear it.
//
// Without this a filter is invisible: the list is short, nothing explains why, and it looks like
// data has gone missing. That is exactly how a shared search field turned into an alarming bug
// rather than a small annoyance.
function showFilterNotice(noticeId, container, term, showing, total, onClear) {
    const existing = document.getElementById(noticeId);
    if (existing) existing.remove();

    const trimmed = String(term || '').trim();
    if (!trimmed || !container || !container.parentNode) return;

    const notice = document.createElement('div');
    notice.id = noticeId;
    notice.className = 'filter-notice';
    notice.innerHTML = `
        <span>
            <i class="fas fa-filter"></i>
            Showing ${showing} of ${total}, filtered by "${CastEscape.escapeHtml(trimmed)}"
        </span>
        <button type="button">Clear search</button>
    `;
    notice.querySelector('button').addEventListener('click', onClear);
    container.parentNode.insertBefore(notice, container);
}

function clearCharacterSearch() {
    state.characterSearchTerm = '';
    const input = document.getElementById('search-characters-input');
    if (input) input.value = '';
    renderFilteredAndSortedCharacters();
}

function clearSidebarSearch() {
    state.sidebarSearchTerm = '';
    const input = document.getElementById('sidebar-search');
    if (input) input.value = '';
    updateSidebarCharacters();
}

// Search, on both the home screen and the list beside a chat.
// Light or dark.
//
// Three settings rather than two, because following the device is what most people want and a fixed
// choice is what the rest want. The class is put on the html element by a small script in the page
// head as well, before anything is drawn, so the light theme never flashes before the dark one
// arrives.
function getTheme() {
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const ui = stored.value || {};
    return ['auto', 'light', 'dark'].includes(ui.theme) ? ui.theme : 'auto';
}

function prefersDarkDevice() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(theme) {
    const chosen = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
    const dark = chosen === 'dark' || (chosen === 'auto' && prefersDarkDevice());
    document.documentElement.classList.toggle('dark', dark);
    return chosen;
}

function setupThemeChoice() {
    const current = getTheme();
    applyTheme(current);

    const select = document.getElementById('theme-select');
    if (select) {
        select.value = current;
        select.addEventListener('change', () => {
            const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
            const ui = Object.assign({}, stored.value || {}, { theme: select.value });
            castStore.write(CastStorage.KEYS.UI_STATE, ui);
            applyTheme(select.value);
        });
    }

    // Follow the device as it changes, which matters for anyone whose system switches at sunset.
    if (window.matchMedia) {
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (getTheme() === 'auto') applyTheme('auto'); };
        if (query.addEventListener) query.addEventListener('change', onChange);
        else if (query.addListener) query.addListener(onChange);
    }
}

// Which chat layout is in use.
//
// Modern is the board of characters. Classic is the list down the side, kept because it is
// what the app has always looked like and some people will prefer it.
function getChatLayout() {
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const ui = stored.value || {};
    return ui.chatLayout === 'classic' ? 'classic' : 'modern';
}

function applyChatLayout(mode) {
    const layout = mode === 'classic' ? 'classic' : 'modern';
    // Kept on both, because the class is put on the html element before the page is drawn
    // to avoid a flash, and the rest of the app reads it from the body.
    [document.documentElement, document.body].forEach(function (element) {
        element.classList.toggle('layout-classic', layout === 'classic');
        element.classList.toggle('layout-modern', layout === 'modern');
    });

    // The classic list can be hidden. The modern board is the navigation, so hiding it
    // would leave nothing to navigate with.
    if (layout === 'modern') {
        document.body.classList.remove('sidebar-hidden');
    }

    return layout;
}

// Asks the proxy whether it is there.
//
// Worth having as its own button, because a chat failing tells you almost nothing about which link
// in the chain broke. This asks the proxy directly and reports exactly what came back.
async function testProxy() {
    const status = document.getElementById('proxy-status');
    const button = document.getElementById('test-proxy-btn');
    const proxyUrl = getProxyUrl();

    const say = (text, tone) => {
        if (!status) return;
        status.textContent = text;
        status.className = `text-xs mt-1 ${tone}`;
    };

    if (!proxyUrl) {
        say('There is no proxy address. Opening the file directly means there is no server to run one, so deploy the app or set an address above.', 'text-amber-600');
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'Testing...'; }
    say(`Asking ${proxyUrl}...`, 'text-gray-500');

    try {
        // No target on purpose. A working proxy replies with a complaint about that, which is proof
        // it is running.
        const response = await fetch(proxyUrl, { method: 'POST' });
        const body = await response.text();

        let parsed = null;
        try { parsed = JSON.parse(body); } catch (error) { parsed = null; }

        if (parsed && parsed.error && parsed.error.source === 'cast-proxy') {
            say(`Working. The proxy answered from ${proxyUrl}, so providers that need it should work.`, 'text-green-600');
            return;
        }

        if (/^\s*<(!doctype|html)/i.test(body) || response.status === 404) {
            say(`Not deployed. ${proxyUrl} returned ${response.status} and a web page rather than the function. Check that netlify/functions is committed and that the deploy log mentions bundling ai-proxy.`, 'text-red-600');
            return;
        }

        say(`Something answered at ${proxyUrl} with ${response.status}, but it was not the proxy. First part of the reply: ${body.slice(0, 120)}`, 'text-amber-600');
    } catch (error) {
        say(`Could not reach ${proxyUrl} at all. ${error.message}`, 'text-red-600');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Test the proxy'; }
    }
}

function setupChatLayoutChoice() {
    const current = getChatLayout();
    applyChatLayout(current);

    document.querySelectorAll('input[name="chat-layout"]').forEach(radio => {
        radio.checked = radio.value === current;
        radio.addEventListener('change', () => {
            if (!radio.checked) return;

            const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
            const ui = Object.assign({}, stored.value || {}, { chatLayout: radio.value });
            castStore.write(CastStorage.KEYS.UI_STATE, ui);

            applyChatLayout(radio.value);
            renderChatHome('');
            updateSidebarCharacters();

            notify(radio.value === 'modern'
                ? 'Using the modern board.'
                : 'Using the classic list.', 'success');
        });
    });
}

// Closes the current chat and returns to the home screen.
//
// There was no way back before. Opening a chat replaced the home screen and nothing ever
// brought it back, so it could only be seen again by reloading the page.
function returnToHome() {
    state.activeChat = null;
    state.activeCharacters = [];
    state.selectedCharacters = [];

    const chatWindow = document.getElementById('chat-window');
    const placeholder = document.getElementById('chat-placeholder');
    const chatView = document.getElementById('chat-view');

    if (chatWindow) chatWindow.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
    if (chatView) chatView.classList.remove('chat-active');

    renderChatHome('');
    updateSidebarCharacters();
}

function setupSearchBoxes() {
    const homeSearch = document.getElementById('home-search');
    if (homeSearch) {
        homeSearch.addEventListener('input', debounce(() => renderChatHome(homeSearch.value), 120));
    }

    const sidebarSearch = document.getElementById('sidebar-search');
    if (sidebarSearch) {
        sidebarSearch.addEventListener('input', debounce(() => {
            state.sidebarSearchTerm = sidebarSearch.value;
            updateSidebarCharacters();
        }, 120));
    }
}

// Tells the stylesheet how tall the header actually is.
//
// A lot of the layout is sized as the viewport minus the header, and that used to be
// written as a fixed 56 pixels in a dozen places. Giving the header a taller navigation
// broke every one of them: the chat, characters and settings views all ended up taller
// than the space available, and since that space does not scroll, everything below the
// fold became unreachable.
//
// Measured here and published as a variable, so the layout follows whatever the header
// actually is rather than what it was assumed to be.
function trackHeaderHeight() {
    const header = document.querySelector('header');
    if (!header) return;

    const apply = () => {
        const height = Math.round(header.getBoundingClientRect().height);
        if (height > 0) {
            document.documentElement.style.setProperty('--header-h', `${height}px`);
        }
    };

    apply();
    window.addEventListener('resize', debounce(apply, 100));

    // Fonts and icons load after first paint and can change the height.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(apply).catch(() => {});
    }

    // Watches the header itself, so anything that changes its size is picked up without
    // having to remember to call this.
    if (typeof ResizeObserver === 'function') {
        try {
            new ResizeObserver(apply).observe(header);
        } catch (error) {
            // Not important enough to worry about if unavailable.
        }
    }
}

// The sliding navigation.
//
// Tap a section and the pill slides to it. Or take hold anywhere on the strip and drag,
// and the pill follows and settles on whichever section you let go nearest to.
//
// The arithmetic is in src/segmentnav.js and tested there. This part only measures the
// page and moves things.
function setupSlidingNav() {
    const nav = document.getElementById('main-nav');
    const pill = document.getElementById('seg-pill');
    if (!nav || !pill) return;

    const items = nav.querySelectorAll('.seg-item');
    if (!items.length) return;

    let segments = [];
    let activeIndex = 0;
    let dragging = false;
    let startPointerX = 0;
    let startLeft = 0;
    let pillWidth = 0;
    let livePillLeft = 0;

    const measure = () => {
        segments = CastSegmentNav.measureSegments(items, nav);
    };

    // Puts the pill somewhere. Called both mid drag and on settling.
    const placePill = (left, width) => {
        livePillLeft = left;
        pill.style.width = `${width}px`;
        pill.style.transform = `translateX(${left}px)`;
        paintLabels(left, width);
    };

    // Lights the labels according to where the pill is, so the one underneath it is
    // always the readable one rather than only lighting up at the end.
    const paintLabels = (left, width) => {
        segments.forEach((segment, index) => {
            const item = items[index];
            if (!item) return;
            const emphasis = CastSegmentNav.labelEmphasis(left, width, segment);
            item.classList.toggle('is-active', emphasis > 0.5);
        });
    };

    // Settles on a section, and tells the app to change view.
    const settleOn = (index, { navigate = true } = {}) => {
        measure();
        const target = CastSegmentNav.segmentGeometry(segments, index);
        activeIndex = CastSegmentNav.clamp(index, 0, segments.length - 1);
        pillWidth = target.width;
        placePill(target.left, target.width);

        items.forEach((item, i) => {
            item.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
        });

        const view = segments[activeIndex] ? segments[activeIndex].view : '';
        if (navigate && view) changeView(view);
    };

    // Lets other parts of the app move the pill, for instance when a view is opened by
    // something other than this strip.
    window.castMoveNavTo = (view) => {
        measure();
        const index = segments.findIndex(segment => segment.view === view);
        if (index !== -1 && index !== activeIndex) settleOn(index, { navigate: false });
    };

    // --- Dragging ---

    const onPointerDown = (event) => {
        // Left button or touch only.
        if (event.button !== undefined && event.button !== 0) return;

        measure();
        const current = CastSegmentNav.segmentGeometry(segments, activeIndex);
        pillWidth = current.width;
        startLeft = current.left;
        startPointerX = event.clientX;
        dragging = true;

        nav.classList.add('is-dragging');
        if (nav.setPointerCapture && event.pointerId !== undefined) {
            try { nav.setPointerCapture(event.pointerId); } catch (error) { /* not important */ }
        }
    };

    const onPointerMove = (event) => {
        if (!dragging) return;
        event.preventDefault();

        // Bounded by the first and last sections rather than by the strip's full width,
        // because the strip has padding and the pill would otherwise slide out over it.
        const first = segments[0];
        const last = segments[segments.length - 1];
        const lowest = first ? first.left : 0;
        const highest = last ? (last.left + last.width - pillWidth) : 0;

        const followed = startLeft + (event.clientX - startPointerX);
        const left = CastSegmentNav.clamp(followed, lowest, Math.max(lowest, highest));
        placePill(left, pillWidth);
    };

    const onPointerUp = (event) => {
        if (!dragging) return;
        dragging = false;
        nav.classList.remove('is-dragging');

        // A still finger is a tap on whichever section is under it.
        //
        // Which section that is has to be worked out from where the pointer is, not from
        // the event target. Capturing the pointer retargets every later pointer event to
        // the strip itself, so the target was never the button and a tap did nothing at
        // all. Only dragging worked.
        if (CastSegmentNav.wasATap(startPointerX, event.clientX)) {
            const navBox = nav.getBoundingClientRect();
            const localX = event.clientX - navBox.left;
            const tappedIndex = segments.findIndex(segment =>
                localX >= segment.left && localX <= segment.left + segment.width
            );
            settleOn(tappedIndex === -1 ? activeIndex : tappedIndex);
            return;
        }

        settleOn(CastSegmentNav.nearestIndex(livePillLeft, pillWidth, segments));
    };

    nav.addEventListener('pointerdown', onPointerDown);
    nav.addEventListener('pointermove', onPointerMove);
    nav.addEventListener('pointerup', onPointerUp);

    // Swallow the click that follows a pointer interaction.
    //
    // The buttons carry their own click handlers from elsewhere in the app, each one
    // switching to its own section. Releasing a drag over one button while the pill has
    // settled on another meant two different sections were requested: the pill went where
    // it was dropped, then the click sent the view somewhere else, and the two disagreed.
    // The pointer handling above already decides where to go, so the click is redundant.
    //
    // Checked with detail, which is the click count for a real press and zero for a click
    // synthesised by pressing Enter or Space on a focused button. So keyboard use still
    // works normally and only pointer driven clicks are dropped.
    nav.addEventListener('click', (event) => {
        if (event.detail > 0) {
            event.stopPropagation();
            event.preventDefault();
        }
    }, true);

    nav.addEventListener('pointercancel', () => {
        if (!dragging) return;
        dragging = false;
        nav.classList.remove('is-dragging');
        settleOn(activeIndex, { navigate: false });
    });

    // --- Keyboard ---

    nav.addEventListener('keydown', (event) => {
        const next = CastSegmentNav.indexForKey(event.key, activeIndex, items.length);
        if (next !== activeIndex) {
            event.preventDefault();
            settleOn(next);
            if (items[next]) items[next].focus();
        }
    });

    // Fonts loading or the window changing size both move the sections, so remeasure.
    window.addEventListener('resize', debounce(() => settleOn(activeIndex, { navigate: false }), 120));
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => settleOn(activeIndex, { navigate: false })).catch(() => {});
    }

    // Place it without navigating, so setting up does not change the view.
    settleOn(0, { navigate: false });
}

// Hiding the character list on a wide screen, and remembering that you hid it.
//
// Only affects desktop. On a phone the list is the main screen and tapping a name opens
// the chat, which works well, so nothing there changes.
function setupSidebarCollapse() {
    const hideBtn = document.getElementById('hide-sidebar-btn');
    const revealBtn = document.getElementById('reveal-sidebar-btn');

    const apply = (hidden) => {
        document.body.classList.toggle('sidebar-hidden', hidden);
    };

    // Restored before anything is drawn, so it does not flash open and then close.
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const uiState = stored.value || {};
    apply(Boolean(uiState.sidebarHidden));

    const remember = (hidden) => {
        const next = Object.assign({}, uiState, { sidebarHidden: hidden });
        castStore.write(CastStorage.KEYS.UI_STATE, next);
        uiState.sidebarHidden = hidden;
    };

    if (hideBtn) {
        hideBtn.addEventListener('click', () => { apply(true); remember(true); });
    }
    const revealMain = document.getElementById('reveal-sidebar-main');

    const homeBtn = document.getElementById('back-to-home-btn');
    if (homeBtn) homeBtn.addEventListener('click', returnToHome);

    [revealBtn, revealMain].forEach(button => {
        if (!button) return;
        button.addEventListener('click', () => { apply(false); remember(false); });
    });
}

// Initialize sidebar functionality
function initializeSidebar() {
    const sidebar = document.getElementById('character-sidebar');
    const toggleBtn = document.getElementById('toggle-sidebar-btn');
    const showCharactersBtn = document.getElementById('show-characters-btn');
    const showChatSidebarBtn = document.getElementById('show-chat-sidebar-btn');
    const chatView = document.getElementById('chat-view');
    const header = document.querySelector('header');

    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Toggle sidebar function
    function toggleSidebar() {
        sidebar.classList.toggle('sidebar-open');

        // Only use overlay on non-mobile devices
        if (window.innerWidth > 768) {
            overlay.classList.toggle('active');
        }

        // This used to set an inline overflow of hidden on the body while the list was
        // open, and clear it when closed. An inline style beats the stylesheet, and the
        // list can be closed by other routes that never run this function, so the lock
        // stayed on and scrolling was dead on every page until the list was opened and
        // closed again. That is the scroll break that kept coming back.
        //
        // Whether the page scrolls is decided by the stylesheet, from the current view.
        if (!sidebar.classList.contains('sidebar-open')) {
            // Small delay to ensure overlay is fully hidden before allowing interaction
            if (window.innerWidth > 768) {
                setTimeout(() => {
                    if (!sidebar.classList.contains('sidebar-open')) {
                        overlay.style.display = 'none';
                        setTimeout(() => {
                            overlay.style.display = '';
                        }, 50);
                    }
                }, 300); // Match the transition duration
            }
        }
    }

    // Function to adjust sidebar position based on header height
    function adjustSidebarPosition() {
        if (window.innerWidth < 1024) {
            const headerHeight = header.offsetHeight;
            sidebar.style.top = `${headerHeight}px`;

            // Update main content padding to account for fixed header
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = `${headerHeight}px`;
            }

            // Update height and max-height to ensure proper scrolling
            sidebar.style.height = `calc(100vh - ${headerHeight}px)`;
            sidebar.style.maxHeight = `calc(100vh - ${headerHeight}px)`;
        } else {
            sidebar.style.top = '';
            sidebar.style.height = '';
            sidebar.style.maxHeight = '';

            // Reset main padding for desktop
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = '';
            }
        }
    }

    // Call initially to set the correct position
    adjustSidebarPosition();

    // Add click events for all toggle buttons
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showCharactersBtn) {
        showCharactersBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showChatSidebarBtn) {
        showChatSidebarBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    overlay.addEventListener('click', toggleSidebar);

    // Close sidebar on chat start in mobile view
    const originalStartChat = startChat;
    startChat = function () {
        originalStartChat();
        if (window.innerWidth < 1024) { // lg breakpoint
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
            chatView.classList.add('chat-active');
        }
    };

    // Handle scroll events to ensure sidebar stays fixed
    window.addEventListener('scroll', () => {
        if (window.innerWidth < 1024) {
            // No need to reposition on scroll since it's fixed in CSS
            // But we can add this as a hook for any future scroll-based adjustments
        }
    });

    // Handle resize events
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) {
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
        }
        adjustSidebarPosition();
    });
}

// Set up direct click handlers that don't rely on generated HTML
function setupDirectListeners() {
    // Menu buttons
    document.querySelectorAll('[id$="-btn"]').forEach(button => {
        if (button.id === 'chat-btn') {
            button.addEventListener('click', () => changeView('chat'));
        } else if (button.id === 'characters-btn') {
            button.addEventListener('click', () => changeView('characters'));
        } else if (button.id === 'settings-btn') {
            button.addEventListener('click', () => changeView('settings'));
        } else if (button.id === 'test-chat-btn') {
            button.addEventListener('click', () => forceOpenChat());
        }
    });

    // Character create button
    const createCharBtn = document.getElementById('create-character-btn');
    if (createCharBtn) {
        createCharBtn.addEventListener('click', createNewCharacter);
    }

    // Error dismiss button
    // The error banner this used to wire up has been replaced by notifications, which build
    // and remove their own controls.
}

// Load data from localStorage
function loadStoredData() {
    console.log("Loading stored data");
    storageProblems = [];

    // Everything is read in one pass, and a problem with any one key cannot stop
    // the others from loading or stop the app from starting. The old version
    // read the keys one after another with no guard, so a single value of the
    // wrong type threw partway through and the app came up blank.
    const loaded = CastStorage.loadAll(castStore);
    loaded.problems.forEach(recordStorageProblem);

    state.apiKey = loaded.data.apiKey || "";
    state.characters = loaded.data.characters;
    state.chats = loaded.data.chats;
    state.chatHistory = loaded.data.chatHistory;
    state.lastActiveChats = loaded.data.lastActiveChats;
    state.chatMembers = loaded.data.chatMembers || {};
    state.chatMemory = loaded.data.chatMemory || {};
    state.activityLog = loaded.data.activityLog || [];

    // Look over the chat history without changing it. This used to delete any
    // entry whose chat body was missing and save the result immediately, which
    // meant one unreadable value in the chats key destroyed the entire history
    // for good. It is now read only.
    const review = CastStorage.reviewChatHistory(state.chatHistory, state.chats);
    state.usableChatHistory = review.usable;
    state.orphanedChats = review.orphans;
    if (review.orphans.length) {
        console.warn(`${review.orphans.length} chat history entries have no matching chat body. They are hidden but have not been deleted.`);
    }

    // Work out which characters each chat belongs to. This used to be guessed by
    // splitting the chat ID on dashes, which treated the timestamp on a new chat
    // as though it were a character ID. That is what filed history under keys
    // like "abc123-1741404473116" instead of just "abc123".
    ensureChatMembership();

    // Load app settings
    const storedSettings = loaded.data.settings;
    if (storedSettings && Object.keys(storedSettings).length) {
        appSettings = { ...appSettings, ...storedSettings };
    }

    migrateSettingsShape();

    // Load personal context
    const storedContext = loaded.data.personalContext;
    if (storedContext && Object.keys(storedContext).length) {
        state.personalContext = { ...state.personalContext, ...storedContext };
    }

    // Set up the UI based on loaded data
    const apiKeyInput = document.getElementById('api-key-input');
    if (apiKeyInput && state.apiKey) {
        apiKeyInput.value = state.apiKey;
    }


    // Set personal context fields
    const nameInput = document.getElementById('user-name');
    const personalityInput = document.getElementById('user-personality');
    const contextInput = document.getElementById('user-context');

    if (nameInput) nameInput.value = state.personalContext.name;
    if (personalityInput) personalityInput.value = state.personalContext.personality;
    if (contextInput) contextInput.value = state.personalContext.context;

    // Update UI
    updateSidebarCharacters();
    // Initialize search and sort UI elements
    const searchInput = document.getElementById('search-characters-input');
    const sortSelect = document.getElementById('sort-characters-select');
    if (searchInput) {
        // Reads its own term, not the chat list's.
        searchInput.value = state.characterSearchTerm;
    }
    if (sortSelect) {
        sortSelect.value = state.characterSortOrder;
    }

    // Check API key
    checkApiKey();
}

// Brings older settings up to date without losing anyone's choices.
//
// The important part is that a model name this app has never seen is left
// exactly as typed, because an unfamiliar name is far more likely to be a model
// released after this code was written than a mistake.
function migrateSettingsShape() {
    if (!CastProviders.isKnownProvider(appSettings.provider)) {
        appSettings.provider = "gemini";
    } else {
        appSettings.provider = CastProviders.getProvider(appSettings.provider).id;
    }

    // Keys used to be one Gemini key in its own storage slot. They are now a map
    // so several providers can be set up at once and you can switch between them
    // without pasting a key again.
    if (!appSettings.apiKeys || typeof appSettings.apiKeys !== "object") {
        appSettings.apiKeys = {};
    }
    if (state.apiKey && !appSettings.apiKeys.gemini) {
        appSettings.apiKeys.gemini = state.apiKey;
    }

    if (!appSettings.models || typeof appSettings.models !== "object") {
        appSettings.models = {};
    }
    if (!appSettings.baseUrls || typeof appSettings.baseUrls !== "object") {
        appSettings.baseUrls = {};
    }

    // Carry the old single purpose fields across to the new per provider ones.
    if (appSettings.modelVersion && !appSettings.models.gemini) {
        appSettings.models.gemini = CastProviders.migrateModelName(appSettings.modelVersion);
    }
    if (appSettings.ollamaModel && !appSettings.models.ollama) {
        appSettings.models.ollama = appSettings.ollamaModel;
    }
    if (appSettings.lmStudioModel && !appSettings.models.lmstudio) {
        appSettings.models.lmstudio = appSettings.lmStudioModel;
    }
    if (appSettings.ollamaBaseUrl && !appSettings.baseUrls.ollama) {
        appSettings.baseUrls.ollama = appSettings.ollamaBaseUrl;
    }
    if (appSettings.lmStudioBaseUrl && !appSettings.baseUrls.lmstudio) {
        appSettings.baseUrls.lmstudio = appSettings.lmStudioBaseUrl;
    }

    // Fill in a default model for any provider that has one and is still blank.
    CastProviders.listProviders().forEach(provider => {
        if (!appSettings.models[provider.id] && provider.defaultModel) {
            appSettings.models[provider.id] = provider.defaultModel;
        }
    });

    appSettings.models.gemini = CastProviders.migrateModelName(appSettings.models.gemini)
        || CastProviders.PROVIDERS.gemini.defaultModel;

    // A response limit this small leaves a reasoning model no room to answer
    // after it finishes thinking, which is why some replies used to arrive empty.
    const limit = parseInt(appSettings.conversationTokens, 10);
    if (!Number.isFinite(limit) || limit < 1024) {
        appSettings.conversationTokens = 4096;
    }

    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;
}

// Records which characters each chat belongs to, as real data on the chat rather
// than something to be guessed from the shape of the chat ID later.
function ensureChatMembership() {
    if (!state.chatMembers || typeof state.chatMembers !== "object") {
        state.chatMembers = {};
    }

    const knownIds = new Set((state.characters || []).map(c => c && c.id).filter(Boolean));
    let changed = false;

    // Anything already recorded is trusted. For the rest, fall back to reading
    // the old style ID, keeping only the parts that are genuinely character IDs.
    Object.keys(state.chats || {}).forEach(chatId => {
        if (Array.isArray(state.chatMembers[chatId]) && state.chatMembers[chatId].length) return;

        const parts = String(chatId).replace(/^chat_/, "").split("-");
        const members = parts.filter(part => knownIds.has(part));

        if (members.length) {
            state.chatMembers[chatId] = members;
            changed = true;
        }
    });

    // Repair the grouping of any history still filed under a key with a
    // timestamp glued onto it.
    const needsRepair = Object.keys(state.chatHistory || {}).some(key => /-\d{10,}/.test(key));
    if (needsRepair) {
        const repaired = CastBackup.repairHistoryGrouping(state.chatHistory, state.characters);
        state.chatHistory = repaired.chatHistory;
        Object.keys(repaired.chatMembers).forEach(chatId => {
            if (!state.chatMembers[chatId] || !state.chatMembers[chatId].length) {
                state.chatMembers[chatId] = repaired.chatMembers[chatId];
            }
        });
        changed = true;
        console.log(`Regrouped ${repaired.movedGroups} chat history groups that were filed under the wrong key.`);
        setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
    }

    if (changed) {
        setStoredItem(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
    }
}

// The one true copy of a character.
//
// state.characters holds the real records. Everywhere else that holds a character,
// such as state.activeCharacters, should be treated as a hint about which character
// rather than as the character itself, because those can fall behind after an edit.
//
// Anything that reads a description or writes to a character should go through here
// first, so an edit made a moment ago is always the version that gets used.
function getLiveCharacter(idOrCharacter) {
    if (!idOrCharacter) return null;
    const id = typeof idOrCharacter === "string" ? idOrCharacter : idOrCharacter.id;
    if (!id) return null;
    const live = (state.characters || []).find(c => c && c.id === id);
    // If the record has genuinely gone, fall back to whatever was handed in rather
    // than returning nothing, so a reply in flight can still finish.
    return live || (typeof idOrCharacter === "object" ? idOrCharacter : null);
}

// Returns the characters taking part in a chat, using recorded membership rather
// than checking whether one ID happens to appear inside another as text.
//
// When membership has not been recorded yet, it is worked out from the ID and then
// remembered. Chats are created in several places, and having this one function
// record what it derives means every one of them ends up with proper membership
// without each having to remember to do it.
function getChatCharacterIds(chatId) {
    if (!chatId) return [];

    const recorded = state.chatMembers && state.chatMembers[chatId];
    if (Array.isArray(recorded) && recorded.length) return recorded.slice();

    // Only ever keep parts that match a character that actually exists, which is
    // what stops a timestamp being mistaken for a character.
    const knownIds = new Set((state.characters || []).map(c => c && c.id).filter(Boolean));
    const derived = String(chatId).replace(/^chat_/, "").split("-").filter(part => knownIds.has(part));

    if (derived.length) {
        if (!state.chatMembers) state.chatMembers = {};
        state.chatMembers[chatId] = derived;
        // Saved on a short delay so creating several chats at once does not write
        // repeatedly.
        if (state.membershipSaveTimer) clearTimeout(state.membershipSaveTimer);
        state.membershipSaveTimer = setTimeout(() => {
            castStore.write(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
        }, 1000);
    }

    return derived;
}

function chatBelongsToCharacter(chatId, characterId) {
    return getChatCharacterIds(chatId).indexOf(characterId) !== -1;
}

function getChatCharacters(chatId) {
    const ids = getChatCharacterIds(chatId);
    return (state.characters || []).filter(c => c && ids.indexOf(c.id) !== -1);
}

// Writes down what just happened.
//
// Called from the places that change your data, so the log in Settings is a real record
// rather than a guess. Saving is put off for a moment so a burst of changes does not
// mean a burst of writes.
// Safe to call at any point, including before the log has been read from storage and from inside an
// error handler. A failure while recording a failure would be a poor way to lose the record of it.
function recordActivityIfReady(kind, detail) {
    try {
        if (!state || !Array.isArray(state.activityLog)) return;
        recordActivity(kind, detail);
    } catch (error) {
        console.warn('Could not record that in the log:', error);
    }
}

function recordActivity(kind, detail) {
    state.activityLog = CastLog.append(state.activityLog, kind, detail);

    if (state.logSaveTimer) clearTimeout(state.logSaveTimer);
    state.logSaveTimer = setTimeout(() => {
        castStore.write(CastStorage.KEYS.ACTIVITY_LOG, state.activityLog);
    }, 1500);

    // Anything on screen that reports recent activity should follow along.
    if (typeof updateLastBackupStatus === "function") updateLastBackupStatus();
    if (typeof renderActivityLog === "function") renderActivityLog();
}

// Counts activity so the backup reminder knows whether there is anything worth
// saving. Deliberately cheap, since it runs on every write.
function noteDataChanged(count) {
    // A search result must never be based on messages that have since changed.
    if (typeof clearChatSearchCache === 'function') clearChatSearchCache();

    if (!state.backupState) return;
    state.backupState = CastBackup.recordChange(state.backupState, count);
    // Keep the visible line in step with reality.
    if (typeof updateLastBackupStatus === "function") updateLastBackupStatus();
    if (state.backupSaveTimer) clearTimeout(state.backupSaveTimer);
    state.backupSaveTimer = setTimeout(() => {
        castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
    }, 2000);
}

// Set up event listeners
function setupEventListeners() {
    // Chat form submission
    const chatForm = document.getElementById('chat-form');
    const messageInput = document.getElementById('message-input');

    if (chatForm && messageInput) {
        // Handle form submission - updated to include button state update
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            // Call sendMessage which will update the button state
            sendMessage();
        });

        // Handle message input keydown.
        //
        // The decision itself lives in src/input.js so it can be tested. Enter sends,
        // Shift with Enter makes a new line. It used to be that Enter sent only when
        // there was text in the box, and did nothing at all when the box was empty,
        // so Enter inserted a newline in that one case. The placeholder also said
        // "Enter for new line", which was the opposite of what the code did.
        messageInput.addEventListener('keydown', (e) => {
            const action = CastInput.decideKeyAction({
                key: e.key,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                altKey: e.altKey,
                // Set while an input method is composing characters, for example when
                // typing Japanese. Enter confirms the composition there.
                isComposing: e.isComposing || e.keyCode === 229,
                value: messageInput.value,
                responseInProgress: state.isResponseInProgress,
            });

            if (action === 'pass-through') return;

            e.preventDefault();

            if (action === 'newline') {
                const result = CastInput.insertNewline(
                    messageInput.value,
                    messageInput.selectionStart,
                    messageInput.selectionEnd
                );
                messageInput.value = result.value;
                messageInput.selectionStart = messageInput.selectionEnd = result.cursor;
                // Let the box grow to fit the new line.
                messageInput.dispatchEvent(new Event('input'));
                return;
            }

            if (action === 'send') {
                sendMessage();
            }

            // "ignore" falls through, which is the point: nothing happens while a
            // reply is still arriving.
        });

        // Auto-resize input height based on content
        messageInput.addEventListener('input', () => {
            requestAnimationFrame(() => {
                messageInput.style.height = 'auto';
                const newScrollHeight = messageInput.scrollHeight; // Read
                messageInput.style.height = newScrollHeight + 'px'; // Write
            });
        });
    }

    // Make sidebar character items clickable
    updateSidebarCharacterListeners();

    // Save API Key button
    const saveButton = null /* the save control is inside the key row now */;
    if (saveButton) {
        saveButton.addEventListener('click', saveApiKey);
    } else {
        // If no save button, implement API key input event listener
        const apiKeyInput = document.getElementById('api-key-input');
        if (apiKeyInput) {
            apiKeyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveApiKey();
                }
            });
        }
    }

    // Handle window resize for mobile/desktop detection
    window.addEventListener('resize', debounce(() => {
        initMessageDeleteButtons();
    }, 250));

    // Setup character creation button
    const createCharacterBtn = document.getElementById('create-character-btn');
    if (createCharacterBtn) {
        createCharacterBtn.addEventListener('click', createNewCharacter);
    }

    // Setup edit character modal
    setupEditCharacterModal();

    // Setup character selection in sidebar
    updateSidebarCharacterListeners();

    // Chat history and new chat buttons
    const newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', createNewChat);
    }

    const chatHistoryBtn = document.getElementById('chat-history-btn');
    if (chatHistoryBtn) {
        chatHistoryBtn.addEventListener('click', showChatHistory);
    }

    const closeHistoryModalBtn = document.getElementById('close-history-modal-btn');
    if (closeHistoryModalBtn) {
        closeHistoryModalBtn.addEventListener('click', closeChatHistoryModal);
    }

    const closeHistoryBtn = document.getElementById('close-history-btn');
    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', closeChatHistoryModal);
    }

    // Setup data export and import buttons
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataBtn = document.getElementById('import-data-btn');

    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', exportAppData);
    }

    if (importDataBtn) {
        importDataBtn.addEventListener('click', importAppData);
    }

    // Setup profile picture handlers
    setupProfilePictureHandlers();

    // Setup focus handling for mobile
    setupFocusHandling();

    // Event listener for character search
    const searchInput = document.getElementById('search-characters-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.characterSearchTerm = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }

    // Event listener for character sort
    const sortSelect = document.getElementById('sort-characters-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            state.characterSortOrder = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }
}

// Update sidebar character event listeners
function updateSidebarCharacterListeners() {
    console.log("Updating sidebar character listeners"); // Debug log

    // This ensures characters are clickable even if onclick attribute doesn't work
    state.characters.forEach(character => {
        const element = document.getElementById(`sidebar-char-${character.id}`);
        if (element) {
            // Remove old event listener to avoid duplicates
            const newElement = element.cloneNode(true);
            element.parentNode.replaceChild(newElement, element);

            // Add fresh event listener
            newElement.addEventListener('click', function (event) {
                event.preventDefault();
                console.log("Character clicked via event listener:", character.id);
                toggleCharacterSelection(character.id);
            });
        } else {
            console.warn(`Sidebar character element for ${character.id} not found`);
        }
    });

    // Also make sure the Start Chat button has its event listener
    // removed it
}

// View management
function changeView(viewName) {
    // Hide all views
    const views = ['chat-view', 'characters-view', 'settings-view'];
    views.forEach(view => {
        const element = document.getElementById(view);
        if (element) {
            element.classList.add('hidden');
            if (view === 'chat-view') {
                element.classList.remove('chat-active');
            }
        }
    });

    // Reset active buttons
    const buttons = ['chat-btn', 'characters-btn', 'settings-btn'];
    // The active look is the sliding pill behind the buttons now, so nothing here paints
    // a background onto them. Doing so would cover the pill.
    buttons.forEach(btn => {
        const element = document.getElementById(btn);
        if (element) element.classList.remove('bg-white', 'text-primary', 'text-white');
    });

    // Make sure nothing has left the page locked.
    //
    // A stray inline overflow on the body is what broke scrolling repeatedly. Clearing it
    // here means that even if something sets it again, changing view puts it right.
    document.body.style.overflow = '';
    document.body.style.position = '';

    // Keep the pill in step when the view is changed by something other than the
    // navigation strip itself.
    if (typeof window.castMoveNavTo === 'function') {
        window.castMoveNavTo(viewName);
    }

    // Toggle body class for fixed positioning only in chat view
    if (viewName === 'chat') {
        document.body.classList.add('chat-view-active');
    } else {
        document.body.classList.remove('chat-view-active');
    }

    // Show selected view and activate button
    if (viewName === 'chat') {
        const view = document.getElementById('chat-view');
        const btn = document.getElementById('chat-btn');
        if (view) {
            view.classList.remove('hidden');
            updateCharacterLists(); // Refresh the list when switching views

            // Add chat-active class if there's an active chat
            if (state.activeChat) {
                view.classList.add('chat-active');
            }
        }
        // The pill marks the current section.
    } else if (viewName === 'characters') {
        const view = document.getElementById('characters-view');
        const btn = document.getElementById('characters-btn');
        if (view) view.classList.remove('hidden');
        // The pill marks the current section.
    } else if (viewName === 'settings') {
        const view = document.getElementById('settings-view');
        const btn = document.getElementById('settings-btn');
        if (view) view.classList.remove('hidden');
        // The pill marks the current section.
    }
}

// Check if API key is set and working
function checkApiKey() {
    const warningElement = document.getElementById('api-warning');
    if (!warningElement) return;

    if (!isProviderConfigured() || !state.isApiConnected || state.activeProvider !== getCurrentProvider()) {
        warningElement.classList.remove('hidden');
    } else {
        warningElement.classList.add('hidden');
    }
}
// Save API key
async function saveApiKey() {
    // The key is stored against whichever provider is selected, so you can have
    // several set up at once and switch between them without pasting a key again.
    // saveVisibleProviderSettings does that, along with the address and model.
    saveVisibleProviderSettings();

    const connected = await initializeAIProvider();
    const savedMessage = document.getElementById('api-saved');
    if (savedMessage) {
        savedMessage.textContent = connected
            ? `Saved. ${getProviderDisplayName()} is connected.`
            : `Saved, but ${getProviderDisplayName()} did not connect. Check the details above.`;
        savedMessage.classList.toggle('text-green-600', connected);
        savedMessage.classList.toggle('text-red-600', !connected);
        savedMessage.classList.remove('hidden');
        setTimeout(() => {
            savedMessage.classList.add('hidden');
        }, 4000);
    }

    checkApiKey();
}
// Nothing may fail silently.
//
// A reply stopped arriving with no message of any kind, which is the worst way for
// something to break: there is nothing to act on and nothing to report. These two
// handlers catch anything that escapes the normal paths, including a failure inside a
// finally block or a promise nobody awaited, both of which otherwise only ever reach the
// console.
function installFailsafeErrorReporting() {
    window.addEventListener('error', (event) => {
        const message = event && event.message ? event.message : 'Something went wrong.';
        console.error('Uncaught error:', event);
        recordActivityIfReady(CastLog.KINDS.UNCAUGHT_ERROR, `${message} at ${event && event.filename ? event.filename.split('/').pop() : 'unknown'}:${(event && event.lineno) || '?'}`);
        showError(`Something broke: ${message}. Your data is safe. Reloading usually clears it.`);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason || 'unknown');
        console.error('Unhandled rejection:', reason);
        recordActivityIfReady(CastLog.KINDS.UNCAUGHT_ERROR, message);
        showError(`Something broke: ${message}. Your data is safe. Reloading usually clears it.`);
    });
}

// The character says they cannot answer right now.
//
// Added as a real reply from them rather than as a system notice, for two reasons. It
// reads as part of the story instead of as a broken app. And the continue feature needs a
// message from each side before it will run, so a failure that left no reply behind made
// pressing enter on an empty box refuse to work as well.
//
// These are never sent to the model. They are marked so the history builders leave them
// out, otherwise the character would start treating their own outage as something that
// happened in the story.
function addCharacterUnavailableReply(chatId, character, error) {
    if (!chatId || !Array.isArray(state.chats[chatId])) return;

    const provider = getProviderConfig();
    const described = CastProviders.describeProviderError(error, provider);

    const line = CastProviders.characterUnavailableLine({
        characterName: character ? character.name : "They",
        userName: state.personalContext ? state.personalContext.name : "",
        description: `${described.short} ${described.advice}`,
    });

    state.chats[chatId].push({
        id: generateUniqueId(),
        content: line,
        isUser: false,
        characterId: character ? character.id : null,
        // Counts as a reply for the continue feature, but never goes to the model.
        isError: true,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    });

    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    recordActivity(CastLog.KINDS.REPLY_FAILED, described.short);

    if (state.activeChat === chatId) updateChatMessages();

    return described;
}

// Puts a failure into the conversation itself, in the chat it belongs to.
//
// A banner at the top of the page can be scrolled away from, covered, or simply missed.
// A bubble sits where you are already looking, and stays there, so a reply that never
// arrived leaves a visible trace of why.
function showChatError(chatId, characterId, message) {
    if (!chatId || !Array.isArray(state.chats[chatId])) return;

    state.chats[chatId].push({
        id: generateUniqueId(),
        content: message,
        isUser: false,
        isSystem: true,
        isError: true,
        characterId: characterId || null,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    });

    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    recordActivity(CastLog.KINDS.REPLY_FAILED, message.slice(0, 120));

    if (state.activeChat === chatId) updateChatMessages();
}

// Notifications.
//
// Everything goes through one place, so a raw error cannot reach the screen no matter which
// call site passes one. Several of them hand over a provider's error object directly, and
// rather than trusting each to remember to tidy it up first, it is handled here.
let toastQueue = [];
const toastTimers = {};

function notify(message, kind, options) {
    const notice = CastToast.prepare({
        message,
        kind,
        title: options && options.title,
    });

    toastQueue = CastToast.enqueue(toastQueue, notice);
    renderToasts();

    // Takes itself away. Nothing sits on screen waiting to be dismissed.
    if (toastTimers[notice.id]) clearTimeout(toastTimers[notice.id]);
    toastTimers[notice.id] = setTimeout(() => dismissToast(notice.id), notice.duration);

    return notice;
}

function dismissToast(id) {
    const element = document.querySelector(`[data-toast-id="${id}"]`);

    if (toastTimers[id]) {
        clearTimeout(toastTimers[id]);
        delete toastTimers[id];
    }

    // Let it animate out before it is taken away.
    if (element) {
        element.classList.add('toast-leaving');
        setTimeout(() => {
            toastQueue = CastToast.dismiss(toastQueue, id);
            renderToasts();
        }, 220);
        return;
    }

    toastQueue = CastToast.dismiss(toastQueue, id);
    renderToasts();
}

function renderToasts() {
    let container = document.getElementById('toast-stack');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-stack';
        document.body.appendChild(container);
    }

    container.innerHTML = toastQueue.map(notice => {
        const icon = CastToast.iconFor(notice.kind);
        const repeated = notice.repeated > 1
            ? `<span class="toast-count">${notice.repeated}</span>`
            : '';
        const more = notice.hasMore
            ? `<span class="toast-more">Full detail is in the log in Settings</span>`
            : '';
        const title = notice.title
            ? `<p class="toast-title">${CastEscape.escapeHtml(notice.title)}${repeated}</p>`
            : '';

        return `
            <div class="toast toast-${CastEscape.escapeAttribute(notice.kind)}" data-toast-id="${CastEscape.escapeAttribute(notice.id)}" role="status">
                <i class="fas ${icon} toast-icon"></i>
                <div class="toast-body">
                    ${title}
                    <p class="toast-message">${CastEscape.escapeHtml(notice.message)}</p>
                    ${more}
                </div>
                <button type="button" class="toast-close" aria-label="Dismiss">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>`;
    }).join('');

    // Tapping anywhere on one dismisses it, which is what people try first.
    container.querySelectorAll('[data-toast-id]').forEach(element => {
        element.addEventListener('click', () => dismissToast(element.getAttribute('data-toast-id')));
    });
}

// The old names, kept so every existing call site keeps working.
function showError(rawMessage) {
    console.warn('Notice:', rawMessage);
    notify(rawMessage, 'error');
}

function showSuccessToast(message) {
    notify(message, 'success');
}

function dismissError() {
    Object.keys(toastTimers).forEach(id => dismissToast(id));
}

// The old banner and its helpers are gone. Notices are small cards that take themselves
// away, so there is nothing left to fill or to hide.
function showErrorText(message) {
    notify(message, 'error');
}

// Character management
function createNewCharacter() {
    // Get input fields
    const nameInput = document.getElementById('character-name');
    const contextInput = document.getElementById('character-context');

    if (!nameInput || !contextInput) {
        showError("Character creation form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();

    // Better validation with more specific error messages
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // The picture is held in state by the upload handler, already shrunk. Read
    // the preview as a fallback for the case where it was set some other way.
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    let profilePicture = state.pendingProfilePicture || null;

    if (!profilePicture && profilePicturePreview && profilePicturePreview.querySelector('img')) {
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Create new character.
    //
    // Note that the picture is not part of this record. It goes into its own
    // store, which is why adding characters no longer eats into the small
    // allowance the browser gives us for chats and settings.
    const newCharacter = {
        id: generateUniqueId(),
        name,
        userContext: context,
        enhancedContext: null,
        hasPicture: Boolean(profilePicture),
        createdAt: new Date().toISOString(),
    };

    console.log("Creating new character:", newCharacter.name);
    recordActivity(CastLog.KINDS.CHARACTER_ADDED, newCharacter.name);

    if (profilePicture) {
        CastImages.putPicture(newCharacter.id, profilePicture)
            .then(() => {
                state.pictureCache[newCharacter.id] = profilePicture;
                updateCharacterLists();
                updateSidebarCharacters();
            })
            .catch(error => {
                console.warn("That picture could not be saved:", error);
                recordActivityIfReady(CastLog.KINDS.PICTURE_PROBLEM, `could not save the picture for ${newCharacter.name}: ${error.message}`);
                showError("The character was saved but the picture could not be. Try a different image.");
            });
    }
    state.pendingProfilePicture = null;

    // Add to state and save
    state.characters.push(newCharacter);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Clear inputs AFTER validation and saving
    nameInput.value = '';
    contextInput.value = '';

    // Reset profile picture preview
    if (profilePicturePreview) {
        profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
        profilePicturePreview.classList.remove('has-image');

        // Hide the remove button
        const removeButton = document.getElementById('remove-profile-picture');
        if (removeButton) {
            removeButton.classList.add('hidden');
        }
    }

    // Show success message
    showSuccess(`Character "${name}" created successfully!`);

    // Instead of re-rendering the entire list, append the new element:
    const characterListContainer = document.getElementById('character-list');
    if (characterListContainer) {
        // Remove "no characters" message if present
        const noChars = document.getElementById('no-characters');
        if (noChars) { noChars.remove(); }

        // Create a new div element for the character
        const newCharDiv = document.createElement('div');
        newCharDiv.id = `character-item-${newCharacter.id}`;
        newCharDiv.className = "border rounded-lg p-4 hover:shadow-md transition";

        // Determine how to display the character avatar
        const newSafeName = CastEscape.escapeHtml(newCharacter.name);
        const newPicture = CastEscape.safeImageUrl(profilePicture || getCharacterPicture(newCharacter));
        let avatarHTML = '';
        if (newPicture) {
            avatarHTML = `<img src="${newPicture}" alt="${newSafeName}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${CastEscape.initial(newCharacter.name)}</div>`;
        }

        newCharDiv.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${newCharacter.name}</h3>
                </div>
                <div class="flex space-x-2">
                    <button id="edit-btn-${newCharacter.id}" class="text-blue-500 hover:text-blue-700" title="Edit character">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button id="delete-btn-${newCharacter.id}" class="text-red-500 hover:text-red-700" title="Delete character">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>

            <div class="mt-2">
                <p class="text-sm text-gray-700 font-semibold">User-Provided Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-32 overflow-auto p-1 border rounded bg-gray-50">
                    ${newCharacter.userContext}
                </div>
            </div>

            ${newCharacter.enhancedContext ? `
            <div class="mt-3 bg-gray-50 p-2 rounded enhanced-context" id="enhanced-context-${newCharacter.id}">
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${newCharacter.enhancedContext}
                </div>
            </div>
            ` : ''}

            <div class="mt-3 flex justify-center">
                <button id="enhance-btn-${newCharacter.id}" class="text-sm bg-secondary text-white px-3 py-1 rounded hover:bg-secondary/90 transition ${!isProviderConfigured() ? 'disabled:bg-gray-400' : ''}" ${!isProviderConfigured() ? 'disabled' : ''}>
                    <i class="fas fa-magic mr-1"></i> ${newCharacter.enhancedContext ? 'Re-Enhance Context' : 'Enhance Context'}
                </button>
            </div>
        `;

        // Append the new character element to the container
        characterListContainer.appendChild(newCharDiv);

        // Set up event listeners for the new element:
        const editBtn = newCharDiv.querySelector(`#edit-btn-${newCharacter.id}`);
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.preventDefault();
                editCharacter(newCharacter.id);
            });
        }

        const deleteBtn = newCharDiv.querySelector(`#delete-btn-${newCharacter.id}`);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await deleteCharacter(newCharacter.id);
            });
        }

        const enhanceBtn = newCharDiv.querySelector(`#enhance-btn-${newCharacter.id}`);
        if (enhanceBtn) {
            enhanceBtn.addEventListener('click', (e) => {
                e.preventDefault();
                enhanceCharacterContext(newCharacter.id);
            });
        }
    }

    // Also update the sidebar if needed
    updateSidebarCharacters();

    // Full UI update
    updateCharacterLists();
    window.scrollTo(0, document.body.scrollHeight); // scroll to bottom to see new character

    // If the characters view is currently hidden, switch to it
    if (document.getElementById('characters-view').classList.contains('hidden')) {
        changeView('characters');
    }
    return true;
}

// Helper function to set up event listeners for character items
function setupCharacterItemListeners() {
    // Set up enhance button event listeners
    document.querySelectorAll('[id^="enhance-btn-"]').forEach(button => {
        const characterId = button.id.replace('enhance-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            enhanceCharacterContext(characterId);
        });
    });

    // Set up edit button event listeners
    document.querySelectorAll('[id^="edit-btn-"]').forEach(button => {
        const characterId = button.id.replace('edit-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            editCharacter(characterId);
        });
    });

    // Set up delete button event listeners
    document.querySelectorAll('[id^="delete-btn-"]').forEach(button => {
        const characterId = button.id.replace('delete-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await deleteCharacter(characterId);
        });
    });
}

// Function to generate HTML for character list
function generateCharacterListHTML() {
    // Uses the same card as everywhere else, so the three copies of this markup that used to
    // drift apart are now one.
    return state.characters.map(characterCardHTML).join('');
}

// Function to update just the sidebar character list
function updateSidebarCharacters() {
    // The home screen shows the same information, so it is refreshed alongside.
    if (typeof renderChatHome === 'function') {
        try { renderChatHome(); } catch (error) { console.warn('Home screen could not be drawn:', error); }
    }
    const sidebarCharactersContainer = document.getElementById('sidebar-characters');

    if (!sidebarCharactersContainer) {
        console.error("Sidebar characters container not found");
        return;
    }

    try {
        if (state.characters.length === 0) {
            sidebarCharactersContainer.innerHTML = `
                <p class="text-gray-500 italic p-4 text-sm">
                    No characters created yet. Go to Characters tab to create some.
                </p>
            `;
        } else {
            // Only the ones matching what you typed.
            const visibleCharacters = filterCharacters(state.characters, state.sidebarSearchTerm);

            showFilterNotice(
                'sidebar-filter-notice',
                sidebarCharactersContainer,
                state.sidebarSearchTerm,
                visibleCharacters.length,
                state.characters.length,
                clearSidebarSearch
            );

            if (!visibleCharacters.length) {
                sidebarCharactersContainer.innerHTML = `
                    <p class="text-gray-500 italic p-4 text-sm">
                        Nobody matches that search.
                        <button type="button" class="text-primary underline not-italic" onclick="clearSidebarSearch()">Clear it</button>
                    </p>
                `;
                return;
            }

            // Sorted by when you last talked to someone.
            //
            // There used to be a rule here putting whoever was selected at the top. That was
            // the other half of the reordering complaint: even after the timestamp was fixed,
            // opening a character still moved them, because this rule moved them separately.
            // The order now only reflects real conversation activity.
            const sortedCharacters = [...visibleCharacters].sort((a, b) => {
                const aTimestamp = getLastMessageTimestamp(a.id);
                const bTimestamp = getLastMessageTimestamp(b.id);

                // Ensure createdAt is valid, default to 0 if not (for very old data potentially)
                const aCreationTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bCreationTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

                // Rule 1: If one character has chats (timestamp > 0) and the other doesn't (timestamp == 0),
                // the one without chats (potentially newer) comes first (return -1 for a, 1 for b).
                if (aTimestamp === 0 && bTimestamp !== 0) return -1;
                if (aTimestamp !== 0 && bTimestamp === 0) return 1;

                // Rule 2: If both characters have no chats (both timestamps are 0),
                // sort by most recent creation time (descending order, so newer characters first).
                if (aTimestamp === 0 && bTimestamp === 0) {
                    return bCreationTime - aCreationTime;
                }

                // Rule 3: If both characters have chats (both timestamps > 0),
                // sort by most recent message timestamp (descending order).
                return bTimestamp - aTimestamp;
            });

            const sidebarHTML = sortedCharacters.map(character => {
                const lastMessageTime = getLastMessageTimestamp(character.id);
                const hasRecentChat = lastMessageTime > 0;
                const isActive = state.activeCharacters && state.activeCharacters.some(c => c.id === character.id);

                // Format date with time
                const formatDateTime = (timestamp) => {
                    const date = new Date(timestamp);
                    return date.toLocaleString(undefined, {
                        month: '2-digit',
                        day: '2-digit',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    });
                };

                // This is the list you see on a phone, so it matters that it is
                // both safe and quick to draw.
                const safeName = CastEscape.escapeHtml(character.name);
                const picture = CastEscape.safeImageUrl(getCharacterPicture(character));

                let avatarHTML = '';
                let avatarClass = '';
                if (picture) {
                    avatarHTML = `<img src="${picture}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
                    avatarClass = 'has-image';
                } else {
                    avatarHTML = CastEscape.initial(character.name);
                    avatarClass = '';
                }

                return `
                <div 
                    id="sidebar-char-${character.id}"
                    data-character-id="${character.id}"
                    class="p-3 rounded mb-2 cursor-pointer character-item ${state.selectedCharacters.includes(character.id)
                        ? 'bg-primary/10 border-primary/30 border'
                        : 'hover:bg-gray-100 border border-transparent'
                    } ${isActive ? 'border-primary' : ''}"
                >
                    <div class="flex items-center justify-between">
                        <div class="flex items-center">
                            <div class="character-avatar bg-primary/20 text-primary ${avatarClass}">
                                ${avatarHTML}
                            </div>
                            <div class="ml-2 overflow-hidden">
                                <p class="font-medium truncate">${safeName}</p>
                                ${hasRecentChat ? `
                                <p class="text-xs text-gray-500">
                                    Last chat: ${isActive ? 'Active now' : formatDateTime(lastMessageTime)}
                                </p>` : ''}
                            </div>
                        </div>
                        
                        <div class="w-2 h-2 rounded-full ${isActive ? 'bg-primary' : 'bg-primary/50'}"></div>
                    </div>
                </div>
            `}).join('');

            // Use innerHTML for the sidebar update
            sidebarCharactersContainer.innerHTML = sidebarHTML;
        }

        // Setup event listeners for the sidebar characters
        setupSidebarCharacterListeners();

    } catch (error) {
        console.error("Error updating sidebar characters:", error);
    }
}

// Function to setup sidebar character listeners
function setupSidebarCharacterListeners() {
    console.log("Setting up sidebar character listeners");

    document.querySelectorAll('[id^="sidebar-char-"]').forEach(element => {
        const characterId = element.getAttribute('data-character-id');
        if (!characterId) {
            console.warn("Character element without data-character-id:", element);
            return;
        }

        // Remove any existing event listeners by cloning and replacing
        const newElement = element.cloneNode(true);
        element.parentNode.replaceChild(newElement, element);

        // Add fresh event listener using the data attribute
        newElement.addEventListener('click', function (e) {
            e.preventDefault();
            console.log("Character clicked in sidebar:", characterId);
            toggleCharacterSelection(characterId);
        });
    });

    // Also set up the Start Chat button
    // removed it
}

// Character selection in sidebar
function toggleCharacterSelection(characterId) {
    console.log("Character selected:", characterId);

    // Check if character exists
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        console.error("Character not found:", characterId);
        return;
    }

    // Check if this character is already selected
    const wasSelected = state.selectedCharacters.includes(characterId);

    // Save the previous active chat to clean up in-progress system messages
    const previousActiveChat = state.activeChat;

    // Single-character mode is enforced. Selecting a character replaces the current chat target.
    state.selectedCharacters = [characterId];

    // Update UI to reflect selection state
    updateSidebarCharacters();

    // Close the sidebar on mobile after character selection
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('character-sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar && sidebar.classList.contains('sidebar-open')) {
            sidebar.classList.remove('sidebar-open');
            // No need to manage overlay on mobile as it's hidden via CSS
        }
    }

    // If we're removing a character from an active chat
    if (wasSelected && state.selectedCharacters.length === 0) {
        // Show placeholder, hide chat
        const chatWindow = document.getElementById('chat-window');
        const placeholder = document.getElementById('chat-placeholder');

        if (chatWindow) { chatWindow.classList.add('hidden'); }
        if (placeholder) { placeholder.classList.remove('hidden'); }

        // Force a layout refresh
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 10);
    }

    // Clean up any completed pending responses 
    cleanupPendingResponses();

    // Clean up any "continuing conversation" system messages in the previous chat
    if (previousActiveChat && state.chats[previousActiveChat]) {
        const messages = state.chats[previousActiveChat];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Auto-start chat in single character mode
    if (state.selectedCharacters.length === 1) {
        console.log("Auto-starting chat since character was selected");

        // Ensure the character's chat reference is maintained
        ensureCharacterChatReference(characterId);

        // Check if there's a last active chat for this character
        const lastChatId = state.lastActiveChats[characterId];

        if (lastChatId && state.chats[lastChatId]) {
            console.log("Resuming last active chat:", lastChatId);

            // Set as active chat
            state.activeChat = lastChatId;

            // Update active characters
            state.activeCharacters = state.characters.filter(c => state.selectedCharacters.includes(c.id)).slice(0, 1);

            // Ensure the chat has at least one message (add a welcome message if empty)
            if (state.chats[lastChatId].length === 0) {
                const welcomeMsg = {
                    id: generateUniqueId(),
                    content: `Starting conversation with ${state.activeCharacters.map(c => c.name).join(', ')}.`,
                    isUser: false,
                    isSystem: true,
                    timestamp: new Date().toISOString(),
                    isDeleted: false
                };

                state.chats[lastChatId].push(welcomeMsg);
                setStoredItem(STORAGE_KEYS.CHATS, state.chats);
            }

            // Update UI
            changeView('chat');
            updateChatUI();
        } else {
            // Start a new chat if no last active chat exists
            startChat();
        }
    }
}

// Chat functionality
function startChat() {
    console.log("Start chat clicked", state.selectedCharacters); // Debug log

    if (state.selectedCharacters.length === 0) {
        showError("Please select a character to chat with");
        return;
    }

    if (state.selectedCharacters.length > 1) {
        state.selectedCharacters = [state.selectedCharacters[0]];
    }

    // Clean up any existing chat's system messages before changing
    if (state.activeChat && state.chats[state.activeChat]) {
        const messages = state.chats[state.activeChat];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Generate chat ID
    const chatId = [...state.selectedCharacters].sort().join('-');
    state.activeChat = chatId;

    // Ensure chat exists in state
    if (!state.chats[chatId]) {
        state.chats[chatId] = [];
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    }

    // Update active characters
    state.activeCharacters = state.characters.filter(c => state.selectedCharacters.includes(c.id)).slice(0, 1);

    // Save the active chat ID for each selected character
    state.selectedCharacters.forEach(characterId => {
        state.lastActiveChats[characterId] = chatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Create a welcome message for the chat if it's empty
    if (state.chats[chatId].length === 0) {
        // Add greeting message to the chat
        const welcomeMsg = {
            id: generateUniqueId(),
            content: `New conversation started with ${state.activeCharacters.map(c => c.name).join(', ')}`,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };

        // Add welcome message to the chat
        state.chats[chatId].push(welcomeMsg);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // For new conversations, let the character initialize with a greeting
        // But only do this if we're connected to the API
        if (state.isApiConnected && state.activeCharacters.length === 1) {
            // Update UI first
            changeView('chat');
            updateChatUI();

            // Wait a moment for UI to update before triggering greeting
            setTimeout(() => {
                const character = state.activeCharacters[0];

                // Create a special init message that won't be displayed
                const initMsg = {
                    id: generateUniqueId(),
                    content: "Hello",
                    isUser: true,
                    timestamp: new Date().toISOString(),
                    isDeleted: true, // Won't be shown in UI
                    isInitializing: true // Special flag for first-time greeting
                };

                // Generate character's greeting (async)
                getCharacterResponse(character, initMsg);
            }, 500);
        }
    } else {
        // Also clean up any continue messages in this chat
        const messages = state.chats[chatId];
        let hasChanges = false;

        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Update UI - Make sure to switch to chat view first
    changeView('chat');
    updateChatUI();

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();
}

// Helper function to ensure that chat references are maintained when a chat is cleared
function ensureCharacterChatReference(characterId) {
    // Check if the character exists
    const character = state.characters.find(c => c.id === characterId);
    if (!character) return false;

    // Check if there's a last active chat for this character
    const lastChatId = state.lastActiveChats[characterId];

    // If no lastChatId or no chat data exists for it, create a new chat
    if (!lastChatId || !state.chats[lastChatId]) {
        const newChatId = characterId;
        state.lastActiveChats[characterId] = newChatId;
        state.chats[newChatId] = [];

        // Add welcome message
        const welcomeMsg = {
            id: generateUniqueId(),
            content: `New conversation started with ${character.name}.`,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };

        state.chats[newChatId].push(welcomeMsg);

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

        return true;
    }

    return true;
}

// Update the updateChatUI function to check for completed responses
function updateChatUI() {
    console.log("Updating chat UI"); // Debug log

    // Hide placeholder, show chat window
    const placeholder = document.getElementById('chat-placeholder');
    const chatWindow = document.getElementById('chat-window');

    if (placeholder) placeholder.classList.add('hidden');
    if (chatWindow) chatWindow.classList.remove('hidden');

    // Update chat header
    const characterNames = state.activeCharacters.map(c => c.name).join(', ');
    const headerTitle = document.getElementById('chat-header-title');
    if (headerTitle) headerTitle.textContent = characterNames;

    // Update chat header with profile pictures
    const chatHeaderAvatars = document.getElementById('chat-header-avatars');
    if (chatHeaderAvatars) {
        // Clear existing avatars
        chatHeaderAvatars.innerHTML = '';

        // Add avatars for each active character
        state.activeCharacters.forEach(character => {
            const avatarElement = document.createElement('div');
            avatarElement.className = 'character-avatar bg-primary/20 text-primary mr-2';

            const picture = getCharacterPicture(character);
            if (picture) {
                // Built as a node rather than a string, so the name never has to
                // be escaped in the first place.
                const img = document.createElement('img');
                img.src = picture;
                img.alt = character.name;
                img.className = 'w-full h-full object-cover';
                avatarElement.appendChild(img);
                avatarElement.classList.add('has-image');
            } else {
                // textContent never needs escaping, so take the letter directly.
                avatarElement.textContent = (character.name || "?").trim().charAt(0).toUpperCase() || "?";
            }

            chatHeaderAvatars.appendChild(avatarElement);
        });
    }

    // Check for completed responses for the active characters
    if (state.activeCharacters.length > 0 && state.activeChat) {
        state.activeCharacters.forEach(character => {
            if (state.pendingResponses[character.id]) {
                const pendingData = state.pendingResponses[character.id];

                // If the pending response is for this chat but generation is complete
                if (pendingData.chatId === state.activeChat && !pendingData.isGenerating) {
                    // Clean up this entry since we're displaying it now
                    delete state.pendingResponses[character.id];
                }
            }
        });
    }

    // Update messages
    updateChatMessages(); // This function populates the messages

    const messagesContainer = document.getElementById('chat-messages');
    if (messagesContainer) {
        requestAnimationFrame(() => { // Defer scroll to next frame
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        });
    }
}

function updateChatMessages() {
    if (!state.activeChat) return;

    const messagesContainer = document.getElementById('chat-messages');
    if (!messagesContainer) return;

    const messages = state.chats[state.activeChat] || [];

    // Filter out deleted messages
    const visibleMessages = messages.filter(message => !message.isDeleted);

    if (visibleMessages.length === 0) {
        messagesContainer.innerHTML = `
            <div class="text-center text-gray-500 mt-8">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;

        // Make sure the chat window is visible even if empty
        const chatWindow = document.getElementById('chat-window');
        const placeholder = document.getElementById('chat-placeholder');

        if (chatWindow) chatWindow.classList.remove('hidden');
        if (placeholder) placeholder.classList.add('hidden');
    } else {
        // Clear the container before adding new elements
        messagesContainer.innerHTML = '';
        visibleMessages.forEach(message => {
            const messageElement = createMessageHTML(message);
            if (messageElement) { // Ensure messageElement is not null
                messagesContainer.appendChild(messageElement);
            }
        });
    }

    // Scroll to bottom
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Initialize delete buttons based on device type
    initMessageDeleteButtons();
}

function createMessageHTML(message) {
    const mainDiv = document.createElement('div');
    mainDiv.setAttribute('data-message-id', message.id);
    mainDiv.onmouseenter = () => showMessageActions(message.id);
    mainDiv.onmouseleave = () => hideMessageActions(message.id);

    // Helper to create elements with classes
    const createElement = (tag, classes = [], attributes = {}) => {
        const el = document.createElement(tag);
        if (classes.length > 0) el.className = classes.join(' ');
        for (const attr in attributes) {
            el.setAttribute(attr, attributes[attr]);
        }
        return el;
    };

    // processContent function is now defined outside createMessageHTML

    if (message.isTyping) {
        const character = state.characters.find(c => c.id === message.characterId) || { name: 'Unknown', profilePicture: null };
        mainDiv.className = 'flex justify-start w-full';

        const avatarDiv = createElement('div', ['character-avatar', 'bg-primary/20', 'text-primary', 'self-end', 'mb-1', 'mr-1']);
        const typingPicture = getCharacterPicture(character);
        if (typingPicture) {
            avatarDiv.classList.add('has-image');
            const img = createElement('img', ['w-full', 'h-full', 'object-cover'], { src: typingPicture, alt: character.name });
            avatarDiv.appendChild(img);
        } else {
            avatarDiv.textContent = (character.name || "?").trim().charAt(0).toUpperCase() || "?";
        }
        mainDiv.appendChild(avatarDiv);

        const messageContainer = createElement('div', ['message-container-character']);
        const charNameDiv = createElement('div', ['text-xs', 'text-gray-600', 'ml-2', 'mb-1']);
        charNameDiv.textContent = character.name;
        messageContainer.appendChild(charNameDiv);

        const bubbleDiv = createElement('div', ['message-bubble', 'character-message', 'typing-indicator-bubble']);
        const statusDiv = createElement('div', ['typing-status-text']);
        statusDiv.textContent = message.content || `${character.name} is thinking...`;
        const typingIndicator = createElement('div', ['typing-indicator']);
        typingIndicator.setAttribute('aria-label', statusDiv.textContent);
        typingIndicator.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
        bubbleDiv.appendChild(statusDiv);
        bubbleDiv.appendChild(typingIndicator);
        const deleteButton = createElement('button', ['absolute', '-top-3', '-right-3', 'bg-red-500', 'text-white', 'rounded-full', 'w-6', 'h-6', 'flex', 'items-center', 'justify-center', 'shadow', 'hover:bg-red-600', 'transition', 'hidden'], { id: `delete-msg-${message.id}`, title: "Remove stuck typing indicator" });
        deleteButton.innerHTML = '<i class="fas fa-times text-xs"></i>';
        deleteButton.onclick = async () => { await deleteMessage(message.id); };
        bubbleDiv.appendChild(deleteButton);

        messageContainer.appendChild(bubbleDiv);
        mainDiv.appendChild(messageContainer);
        return mainDiv;
    }

    if (message.isSystem) {
        mainDiv.className = 'flex justify-center my-4';
        if (message.content === "...") {
            mainDiv.classList.remove('my-4');
            mainDiv.classList.add('my-2');
            const indicatorDiv = createElement('div', ['system-continue-indicator']);
            indicatorDiv.innerHTML = '<i class="fas fa-ellipsis-h mr-1"></i> Continuing conversation...';
            mainDiv.appendChild(indicatorDiv);
        } else if (message.isError) {
            // A failure, shown where you are already looking rather than only as a
            // banner at the top of the page that is easy to miss or scroll away from.
            const errorBubble = createElement('div', ['chat-error-bubble']);
            const icon = createElement('i', ['fas', 'fa-circle-exclamation']);
            errorBubble.appendChild(icon);
            const text = createElement('span');
            text.textContent = message.content;
            errorBubble.appendChild(text);
            mainDiv.appendChild(errorBubble);
        } else {
            const systemBubble = createElement('div', ['bg-gray-100', 'text-gray-600', 'px-4', 'py-2', 'rounded-full', 'text-sm']);
            systemBubble.textContent = message.content; // System messages are plain text
            mainDiv.appendChild(systemBubble);
        }
        return mainDiv;
    }

    const messageContainerOuter = createElement('div'); // This will be mainDiv for user/char messages
    const messageContainerInner = createElement('div'); // For bubble and timestamp/buttons

    const bubbleDiv = createElement('div', ['message-bubble']);
    // Create a specific element for the textual content
    const textContentDiv = createElement('div', ['message-text-content']);
    textContentDiv.innerHTML = processContent(message.content); // Processed content goes into textContentDiv
    bubbleDiv.appendChild(textContentDiv);

    const deleteButton = createElement('button', ['absolute', '-top-3', '-right-3', 'bg-red-500', 'text-white', 'rounded-full', 'w-6', 'h-6', 'flex', 'items-center', 'justify-center', 'shadow', 'hover:bg-red-600', 'transition', 'hidden'], { id: `delete-msg-${message.id}` });
    deleteButton.innerHTML = '<i class="fas fa-times text-xs"></i>';
    deleteButton.onclick = async () => { await deleteMessage(message.id); };
    bubbleDiv.appendChild(deleteButton); // Delete button is a sibling of textContentDiv
    messageContainerInner.appendChild(bubbleDiv);

    const controlsDiv = createElement('div', ['flex', 'items-center']);
    const timestampDiv = createElement('div', ['text-xs', 'text-gray-500', 'mt-1']);
    const timestampSpan = createElement('span');
    if (message.edited) {
        const editedSpan = createElement('span', ['text-xs', 'italic', 'mr-1']);
        editedSpan.textContent = 'edited';
        timestampSpan.appendChild(editedSpan);
    }
    timestampSpan.appendChild(document.createTextNode(new Date(message.timestamp).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })));
    timestampDiv.appendChild(timestampSpan);


    if (message.isUser) {
        mainDiv.className = 'flex justify-end w-full';
        messageContainerInner.classList.add('message-container-user');
        bubbleDiv.classList.add('user-message');
        controlsDiv.classList.add('justify-end');
        timestampDiv.classList.add('mr-2');

        const isLastUserMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
            return userMessages.length > 0 && userMessages[userMessages.length - 1].id === message.id;
        })();

        if (isLastUserMessage) {
            const editButton = createElement('button', ['ml-2', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Edit message" });
            editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i>';
            editButton.onclick = () => editMessage(message.id);
            timestampDiv.appendChild(editButton);
        }
    } else { // Character message
        const character = state.characters.find(c => c.id === message.characterId) || { name: 'Unknown', profilePicture: null };
        mainDiv.className = 'flex justify-start w-full';

        const avatarDiv = createElement('div', ['character-avatar', 'bg-primary/20', 'text-primary', 'self-end', 'mb-1', 'mr-1']);
        const messagePicture = getCharacterPicture(character);
        if (messagePicture) {
            avatarDiv.classList.add('has-image');
            const img = createElement('img', ['w-full', 'h-full', 'object-cover'], { src: messagePicture, alt: character.name });
            avatarDiv.appendChild(img);
        } else {
            avatarDiv.textContent = (character.name || "?").trim().charAt(0).toUpperCase() || "?";
        }
        mainDiv.appendChild(avatarDiv);

        messageContainerInner.classList.add('message-container-character');
        const charNameDiv = createElement('div', ['text-xs', 'text-gray-600', 'ml-2', 'mb-1']);
        charNameDiv.textContent = character.name;
        messageContainerInner.insertBefore(charNameDiv, bubbleDiv); // Insert name before bubble

        bubbleDiv.classList.add('character-message');
        timestampDiv.classList.add('ml-2');


        const isLastCharacterMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const characterMessages = messages.filter(m => !m.isUser && m.characterId === message.characterId && !m.isDeleted && !m.isTyping);
            return characterMessages.length > 0 && characterMessages[characterMessages.length - 1].id === message.id;
        })();

        const isFollowedByUserMessage = (() => {
            if (!state.activeChat) return false;
            const messages = state.chats[state.activeChat] || [];
            const messageIndex = messages.findIndex(m => m.id === message.id);
            for (let i = messageIndex + 1; i < messages.length; i++) {
                if (messages[i].isUser && !messages[i].isDeleted) return true;
            }
            return false;
        })();

        const showRegenerateButton = isLastCharacterMessage && !isFollowedByUserMessage && !state.isResponseInProgress;

        if (showRegenerateButton) {
            const regenerateButton = createElement('button', ['ml-4', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Regenerate response" });
            regenerateButton.innerHTML = '<i class="fas fa-redo-alt text-xs"></i> <span class="text-xs">Regenerate</span>';
            regenerateButton.onclick = () => regenerateMessage(message.characterId);
            timestampDiv.appendChild(regenerateButton);
        }

        if (isLastCharacterMessage && !state.isResponseInProgress) {
            const editButton = createElement('button', ['ml-4', 'text-primary', 'hover:text-primary/70', 'edit-msg-btn'], { title: "Edit message" });
            editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i> <span class="text-xs">Edit</span>';
            editButton.onclick = () => editMessage(message.id);
            timestampDiv.appendChild(editButton);
        }
    }

    controlsDiv.appendChild(timestampDiv);
    messageContainerInner.appendChild(controlsDiv);
    mainDiv.appendChild(messageContainerInner);

    return mainDiv;
}

// Message action buttons
function showMessageActions(messageId) {
    // Only show/hide on desktop - on mobile they're always visible via CSS
    if (window.innerWidth > 768) {
        const deleteButton = document.getElementById(`delete-msg-${messageId}`);
        if (deleteButton) {
            deleteButton.classList.remove('hidden');
        }

        // Also show edit button with higher opacity
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const editButton = messageElement.querySelector('.edit-msg-btn');
            if (editButton) {
                editButton.style.opacity = '1';
            }
        }
    }
}

function hideMessageActions(messageId) {
    // Only show/hide on desktop - on mobile they're always visible via CSS
    if (window.innerWidth > 768) {
        const deleteButton = document.getElementById(`delete-msg-${messageId}`);
        if (deleteButton) {
            deleteButton.classList.add('hidden');
        }

        // Reduce opacity of edit button
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const editButton = messageElement.querySelector('.edit-msg-btn');
            if (editButton) {
                editButton.style.opacity = '0.7';
            }
        }
    }
}

async function deleteMessage(messageId) {
    if (!state.activeChat) return;

    // Get the messages array
    const messages = state.chats[state.activeChat];
    if (!Array.isArray(messages)) return;
    const messageIndex = messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) return;

    const target = messages[messageIndex];

    // A stuck typing indicator is not content, it is a leftover, so clearing it
    // needs no confirmation. Everything else does.
    if (!target.isTyping) {
        const preview = String(target.content || "").trim().replace(/\s+/g, " ");
        const shortened = preview.length > 70 ? `${preview.slice(0, 70)}...` : preview;

        recordActivityIfReady(CastLog.KINDS.MESSAGE_DELETED, '');
        const confirmed = await CastConfirm.ask({
            title: "Delete this message?",
            message: shortened ? `"${shortened}"` : "This message will be removed from the chat.",
            detail: "The character will no longer see it as part of the conversation.",
            confirmText: "Delete",
            tone: "danger",
        });

        if (!confirmed) return;
    }

    if (messageIndex !== -1) {
        const message = messages[messageIndex];

        // If it's a typing indicator, remove it completely instead of marking as deleted
        if (message.isTyping) {
            // First find and remove any related continue system messages
            // These typically appear right before the typing indicator
            let continueMessageIndex = -1;

            // Look for the continue system message that might be before this typing indicator
            for (let i = messageIndex - 1; i >= 0; i--) {
                const prevMsg = messages[i];
                if (prevMsg.isSystem && prevMsg.content === "...") {
                    continueMessageIndex = i;
                    break;
                }
                // Stop looking if we hit a non-system message
                if (!prevMsg.isSystem) {
                    break;
                }
            }

            // Remove messages in reverse order to avoid index issues
            if (continueMessageIndex !== -1) {
                // Remove the continue system message first
                messages.splice(continueMessageIndex, 1);
                // Now remove the typing indicator (its index has shifted down by 1)
                messages.splice(messageIndex - 1, 1);
            } else {
                // Just remove the typing indicator
                messages.splice(messageIndex, 1);
            }

            showSuccess("Typing indicator removed", 2000);
        } else {
            // Mark regular message as deleted
            messages[messageIndex].isDeleted = true;
        }

        // Save changes
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Update UI
        updateChatMessages();
    }
}

// Start message editing mode
function editMessage(messageId) {
    if (!state.activeChat) return;

    // Get message element and validate ID
    const messages = state.chats[state.activeChat];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex === -1) return;

    const message = messages[messageIndex];
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    // Check if this is a user message - if so, only allow editing the most recent user message
    if (message.isUser) {
        const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
        const isLastUserMessage = userMessages.length > 0 &&
            userMessages[userMessages.length - 1].id === messageId;

        if (!isLastUserMessage) {
            showError("You can only edit your most recent message");
            return;
        }
    } else {
        // For character messages, only allow editing the most recent message from that character
        const characterMessages = messages.filter(m =>
            !m.isUser &&
            m.characterId === message.characterId &&
            !m.isDeleted &&
            !m.isTyping
        );

        const isLastCharacterMessage = characterMessages.length > 0 &&
            characterMessages[characterMessages.length - 1].id === messageId;

        if (!isLastCharacterMessage) {
            showError("You can only edit the most recent message from this character");
            return;
        }
    }

    // Find the message content container
    const contentContainer = messageElement.querySelector('.message-bubble');
    if (!contentContainer) return;

    // Store original content in case user cancels
    contentContainer.setAttribute('data-original-content', contentContainer.innerHTML);

    // Create and set up the textarea
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-message-textarea p-3 border rounded resize min-w-[300px] min-h-[150px]';
    textarea.style.width = '100%';
    textarea.style.maxWidth = '600px'; // Maximum width
    textarea.style.fontSize = '1rem';
    textarea.value = message.content; // Raw content for editing

    // Create save button
    const saveButton = document.createElement('button');
    saveButton.className = 'edit-save-btn bg-primary text-white px-4 py-2 rounded mt-2 text-sm';
    saveButton.innerHTML = '<i class="fas fa-check mr-1"></i> Save';
    saveButton.onclick = () => saveEditedMessage(messageId, textarea.value);

    // Create cancel button
    const cancelButton = document.createElement('button');
    cancelButton.className = 'edit-cancel-btn bg-gray-400 text-white px-4 py-2 rounded mt-2 ml-3 text-sm';
    cancelButton.innerHTML = '<i class="fas fa-times mr-1"></i> Cancel';
    cancelButton.onclick = () => cancelEditMessage(messageId);

    // Create button container
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'edit-buttons flex justify-end mt-3';
    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    // Clear the content container and add the editing elements
    contentContainer.innerHTML = '';
    contentContainer.appendChild(textarea);
    contentContainer.appendChild(buttonContainer);

    // Focus the textarea and place cursor at the end
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    // Add editing class for styling
    contentContainer.classList.add('editing');
}

// Cancel message editing
function cancelEditMessage(messageId) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) return;

    const contentContainer = messageElement.querySelector('.message-bubble');
    if (!contentContainer) return;

    // Restore original content from attribute
    const originalContent = contentContainer.getAttribute('data-original-content');
    if (originalContent) {
        contentContainer.innerHTML = originalContent;
    }

    // Remove editing class
    contentContainer.classList.remove('editing');
}

// Save edited message
function saveEditedMessage(messageId, newContent) {
    if (!state.activeChat) return;

    // Trim content but keep internal whitespace
    newContent = newContent.trim();

    // If content is empty, don't save
    if (!newContent) {
        // Show a quick error message
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const textarea = messageElement.querySelector('textarea');
            if (textarea) {
                textarea.classList.add('border-red-500');
                setTimeout(() => {
                    textarea.classList.remove('border-red-500');
                }, 1500);
            }
        }
        return;
    }

    const messages = state.chats[state.activeChat];
    const messageIndex = messages.findIndex(m => m.id === messageId);

    if (messageIndex !== -1) {
        // Update message content
        messages[messageIndex].content = newContent;

        // Add edited flag and timestamp
        messages[messageIndex].edited = true;
        messages[messageIndex].editedAt = new Date().toISOString();

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Update UI directly instead of full re-render
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            const bubble = messageElement.querySelector('.message-bubble');
            if (bubble) {
                const deleteBtn = bubble.querySelector('button[id^="delete-msg-"]');
                bubble.innerHTML = processContent(newContent); // Update content
                if (deleteBtn) {
                    bubble.appendChild(deleteBtn); // Re-append delete button
                }
            }

            // Update timestamp and add/update "edited" badge
            const timestampDiv = messageElement.querySelector('.text-xs.text-gray-500.mt-1');
            if (timestampDiv) {
                // Get the message object to check if it's a user or character message
                const message = messages[messageIndex];
                const isUser = message.isUser;
                const characterId = message.characterId;

                // Create new timestamp HTML
                let newTimestampHtml = `<span>`;
                if (message.edited) {
                    newTimestampHtml += `<span class="text-xs italic mr-1">edited</span>`;
                }
                newTimestampHtml += `${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;

                // Set the new timestamp HTML
                timestampDiv.innerHTML = newTimestampHtml;

                // Re-create buttons with proper event handlers instead of cloning
                if (isUser) {
                    // For user messages, check if it's the last user message
                    const userMessages = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
                    const isLastUserMessage = userMessages.length > 0 &&
                        userMessages[userMessages.length - 1].id === messageId;

                    if (isLastUserMessage) {
                        // Create edit button with fresh event handler
                        const editButton = document.createElement('button');
                        editButton.className = 'ml-2 text-primary hover:text-primary/70 edit-msg-btn';
                        editButton.title = "Edit message";
                        editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i>';
                        editButton.onclick = () => editMessage(messageId);
                        timestampDiv.appendChild(editButton);
                    }
                } else {
                    // For character messages
                    const characterMessages = messages.filter(m =>
                        !m.isUser &&
                        m.characterId === characterId &&
                        !m.isDeleted &&
                        !m.isTyping
                    );

                    const isLastCharacterMessage = characterMessages.length > 0 &&
                        characterMessages[characterMessages.length - 1].id === messageId;

                    // Check if this message is followed by a user message
                    const isFollowedByUserMessage = (() => {
                        const messageIndex = messages.findIndex(m => m.id === messageId);
                        for (let i = messageIndex + 1; i < messages.length; i++) {
                            if (messages[i].isUser && !messages[i].isDeleted) return true;
                        }
                        return false;
                    })();

                    const showRegenerateButton = isLastCharacterMessage && !isFollowedByUserMessage && !state.isResponseInProgress;

                    // Add regenerate button if needed
                    if (showRegenerateButton) {
                        const regenerateButton = document.createElement('button');
                        regenerateButton.className = 'ml-4 text-primary hover:text-primary/70 edit-msg-btn';
                        regenerateButton.title = "Regenerate response";
                        regenerateButton.innerHTML = '<i class="fas fa-redo-alt text-xs"></i> <span class="text-xs">Regenerate</span>';
                        regenerateButton.onclick = () => regenerateMessage(characterId);
                        timestampDiv.appendChild(regenerateButton);
                    }

                    // Add edit button if it's the last character message
                    if (isLastCharacterMessage) {
                        const editButton = document.createElement('button');
                        editButton.className = 'ml-4 text-primary hover:text-primary/70 edit-msg-btn';
                        editButton.title = "Edit message";
                        editButton.innerHTML = '<i class="fas fa-pencil-alt text-xs"></i> <span class="text-xs">Edit</span>';
                        editButton.onclick = () => editMessage(messageId);
                        timestampDiv.appendChild(editButton);
                    }
                }
            }

            // Cancel editing mode styling
            const contentContainer = messageElement.querySelector('.message-bubble.editing');
            if (contentContainer) {
                contentContainer.classList.remove('editing');
            }

        } else {
            updateChatMessages(); // Fallback if element not found
        }

        // Show success message
        showSuccess("Message updated", 1500);
    }
}

async function clearChatMessages() {
    if (!state.activeChat) return;

    const messages = state.chats[state.activeChat];
    const liveCount = Array.isArray(messages)
        ? messages.filter(m => m && !m.isDeleted && !m.isTyping && !m.isSystem).length
        : 0;

    const confirmed = await CastConfirm.ask({
        title: "Clear this chat?",
        message: liveCount
            ? `All ${liveCount} ${liveCount === 1 ? "message" : "messages"} in this chat will be removed.`
            : "This chat will be emptied.",
        detail: "The character itself is kept. Only this conversation goes.",
        confirmText: "Clear chat",
        tone: "danger",
    });

    if (!confirmed) return;

    // The summary has to go too. Without this the character would still remember a
    // conversation the reader had just cleared, which would be unsettling.
    recordActivity(CastLog.KINDS.CHAT_CLEARED, `${liveCount} messages`);
    clearChatMemory(state.activeChat);

    // Clear messages
    state.chats[state.activeChat] = [];

    // Add a system message to indicate the chat was cleared
    const welcomeMsg = {
        id: generateUniqueId(),
        content: `Chat cleared. You can continue your conversation with ${state.activeCharacters.map(c => c.name).join(', ')}.`,
        isUser: false,
        isSystem: true,
        timestamp: new Date().toISOString(),
        isDeleted: false
    };

    // Add welcome message to the chat
    state.chats[state.activeChat].push(welcomeMsg);

    // Update storage
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update UI
    updateChatMessages();

    // Show success message
    showSuccess("Chat cleared");
}

// Function to create a new chat with the same character(s)
function createNewChat() {
    if (state.activeCharacters.length === 0) return;

    // Save current chat to history before creating a new one
    saveCurrentChatToHistory();

    // Generate a new chat ID with timestamp to ensure uniqueness
    const timestamp = Date.now();
    const characterIds = state.activeCharacters.map(c => c.id).sort();
    const newChatId = `${characterIds.join('-')}-${timestamp}`;

    // Set the new chat as active
    state.activeChat = newChatId;
    state.chats[newChatId] = [];

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update the last active chat for each character
    characterIds.forEach(characterId => {
        state.lastActiveChats[characterId] = newChatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Create a welcome message for the new chat
    const welcomeMsg = {
        id: generateUniqueId(),
        content: `New conversation started with ${state.activeCharacters.map(c => c.name).join(', ')}`,
        isUser: false,
        isSystem: true,
        timestamp: new Date().toISOString(),
        isDeleted: false
    };

    // Add welcome message to the chat
    state.chats[newChatId].push(welcomeMsg);
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Save this new chat to history immediately
    const historyEntry = {
        id: newChatId,
        timestamp: timestamp,
        characterIds: characterIds,
        characterNames: state.activeCharacters.map(c => c.name).join(', '),
        messageCount: 1,
        lastMessage: `Start a new conversation with ${state.activeCharacters.map(c => c.name).join(', ')}`,
        date: new Date(timestamp).toLocaleString()
    };

    // Initialize history for these characters if it doesn't exist
    const historyKey = characterIds.join('-');
    if (!state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = [];
    }

    // Add to history and save
    state.chatHistory[historyKey].push(historyEntry);
    setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);

    // Update UI
    updateChatUI();

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();

    // Show success message
    showSuccess("Started a new chat");
}

// Function to save current chat to history
function saveCurrentChatToHistory() {
    if (!state.activeChat || !state.chats[state.activeChat] || state.chats[state.activeChat].length === 0) {
        return; // Don't save empty chats
    }

    // Which characters this chat belongs to.
    //
    // This used to split the chat ID on dashes and keep any part that parsed as a
    // number in base 36, which a timestamp does. So a new chat with an ID like
    // "abc123-1741404473116" had its timestamp treated as a character, and the
    // history was filed under the whole string instead of under the character.
    // That is why history was scattered across a group per chat.
    //
    // It now uses recorded membership, and only ever keeps IDs that match a
    // character that actually exists.
    const characterIds = getChatCharacterIds(state.activeChat);

    // Skip if no valid character IDs found
    if (characterIds.length === 0 || !state.activeCharacters || state.activeCharacters.length === 0) {
        return;
    }

    // Get the valid messages (not deleted)
    const validMessages = state.chats[state.activeChat].filter(msg => !msg.isDeleted);
    if (validMessages.length === 0) return; // Don't save if all messages are deleted

    // Find the most recent non-system message for the title
    let lastMessage = validMessages[validMessages.length - 1];
    let lastNonSystemMessage = null;

    // Look for the most recent non-system message
    for (let i = validMessages.length - 1; i >= 0; i--) {
        if (!validMessages[i].isSystem) {
            lastNonSystemMessage = validMessages[i];
            break;
        }
    }

    // If we found a non-system message, use it for the title
    if (lastNonSystemMessage) {
        lastMessage = lastNonSystemMessage;
    }

    // Create a history entry
    const timestamp = Date.now();
    const historyEntry = {
        id: state.activeChat,
        timestamp: timestamp,
        characterIds: characterIds,
        characterNames: state.activeCharacters.map(c => c.name).join(', '),
        messageCount: validMessages.length,
        lastMessage: lastMessage.content ? lastMessage.content.substring(0, 50) + (lastMessage.content.length > 50 ? '...' : '') : 'No content',
        date: new Date(timestamp).toLocaleString()
    };

    // Initialize history for these characters if it doesn't exist
    const historyKey = characterIds.join('-');
    if (!state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = [];
    }

    // Check if this chat is already in history
    const existingIndex = state.chatHistory[historyKey].findIndex(entry => entry.id === state.activeChat);

    if (existingIndex >= 0) {
        // Update existing entry
        state.chatHistory[historyKey][existingIndex] = historyEntry;
    } else {
        // Add new entry
        state.chatHistory[historyKey].push(historyEntry);
    }

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
}

// Function to show chat history modal
function showChatHistory() {
    if (state.activeCharacters.length === 0) return;

    // Get character IDs
    const characterIds = state.activeCharacters.map(c => c.id).sort();
    const historyKey = characterIds.join('-');

    // Get history for these characters
    const history = state.chatHistory[historyKey] || [];

    // Update the modal content
    const historyList = document.getElementById('chat-history-list');

    if (history.length === 0) {
        historyList.innerHTML = `<p class="text-gray-500 italic text-center">No chat history available</p>`;
    } else {
        // Sort by timestamp, newest first
        const sortedHistory = [...history].sort((a, b) => b.timestamp - a.timestamp);

        // Update each history entry with the most recent message
        sortedHistory.forEach(entry => {
            if (!entry || !entry.id || !state.chats[entry.id]) return;

            // Get the valid messages (not deleted)
            const validMessages = state.chats[entry.id].filter(msg => !msg.isDeleted);
            if (validMessages.length === 0) return;

            // Find the most recent non-system message for the title
            let lastMessage = validMessages[validMessages.length - 1];

            // Look for the most recent non-system message
            for (let i = validMessages.length - 1; i >= 0; i--) {
                if (!validMessages[i].isSystem) {
                    lastMessage = validMessages[i];
                    break;
                }
            }

            // Update the entry with the most recent message
            entry.lastMessage = lastMessage.content ?
                lastMessage.content.substring(0, 50) + (lastMessage.content.length > 50 ? '...' : '') :
                'No content';
            entry.messageCount = validMessages.length;

            // Update the timestamp and date with the most recent message timestamp
            if (lastMessage.timestamp) {
                const messageTimestamp = new Date(lastMessage.timestamp).getTime();
                if (messageTimestamp > 0) {
                    entry.timestamp = messageTimestamp;
                    entry.date = new Date(messageTimestamp).toLocaleString([], { month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
                }
            }
        });

        let html = '';
        sortedHistory.forEach(entry => {
            if (!entry || !entry.id) return; // Skip undefined entries

            html += `
                <div class="mb-4 p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer chat-history-item" data-chat-id="${entry.id}">
                    <div class="flex justify-between items-start">
                        <h4 class="font-medium text-gray-800">${entry.characterNames || 'Unnamed Chat'}</h4>
                        <span class="text-xs text-gray-500">${entry.date || 'No date'}</span>
                    </div>
                    <p class="text-sm text-gray-600 mt-1">${entry.messageCount || 0} messages</p>
                    <div class="mt-2 bg-gray-100 p-2 rounded">
                        <p class="text-sm text-gray-700">${entry.lastMessage || 'No messages'}</p>
                    </div>
                    <div class="mt-2 pt-2 border-t border-gray-200 flex justify-end">
                        <button class="text-red-500 hover:text-red-700 delete-history-btn p-1" 
                                data-chat-id="${entry.id}" 
                                title="Delete this chat history"
                                onclick="event.stopPropagation();">
                            <i class="fas fa-trash-alt"></i> Delete
                        </button>
                    </div>
                </div>
            `;
        });

        historyList.innerHTML = html;

        // Add click listeners to history items
        const historyItems = document.querySelectorAll('.chat-history-item');
        historyItems.forEach(item => {
            item.addEventListener('click', () => {
                const chatId = item.getAttribute('data-chat-id');
                loadChatFromHistory(chatId);
                closeChatHistoryModal();
            });
        });

        // Add click listeners to delete buttons
        const deleteButtons = document.querySelectorAll('.delete-history-btn');
        deleteButtons.forEach(button => {
            button.addEventListener('click', async (e) => {
                e.stopPropagation(); // Prevent triggering the parent click
                const chatId = button.getAttribute('data-chat-id');
                await deleteChatHistory(chatId, historyKey);
            });
        });
    }

    // Show the modal
    const modal = document.getElementById('chat-history-modal');
    modal.classList.remove('hidden');
}

// Function to close chat history modal
function closeChatHistoryModal() {
    const modal = document.getElementById('chat-history-modal');
    modal.classList.add('hidden');

    // Ensure the chat UI is updated when closing the modal
    // This helps especially after deletion operations
    if (state.activeChat) {
        updateChatUI();
    }
}

// Function to load a chat from history
function loadChatFromHistory(chatId) {
    if (!state.chats[chatId]) {
        showError("Chat not found");
        return;
    }

    // Clean up any "continuing conversation" system messages
    if (state.chats[chatId]) {
        const messages = state.chats[chatId];
        let hasChanges = false;

        // Look for system messages with "..." content (the continue indicator)
        messages.forEach(msg => {
            if (msg.isSystem && msg.content === "..." && !msg.isDeleted) {
                msg.isDeleted = true;
                hasChanges = true;
            }
        });

        // Save changes if needed
        if (hasChanges) {
            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        }
    }

    // Set as active chat
    state.activeChat = chatId;

    // Work out which characters this chat belongs to, using recorded membership
    // rather than trying to read meaning out of the ID text. The old version kept
    // any dash separated part that parsed as a base 36 number, which meant a
    // timestamp was treated as a character ID.
    const characterIds = getChatCharacterIds(chatId);
    state.activeCharacters = state.characters.filter(c => characterIds.includes(c.id)).slice(0, 1);
    state.selectedCharacters = state.activeCharacters.map(c => c.id);

    // Update the last active chat for each character
    characterIds.forEach(characterId => {
        state.lastActiveChats[characterId] = chatId;
    });
    setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);

    // Update UI
    updateChatUI();

    // Show success message
    showSuccess("Loaded chat from history");

    // Update sidebar to show the most recent characters at the top
    updateSidebarCharacters();

    // Close the chat history modal
    closeChatHistoryModal();
}

// Function to delete a chat from history
async function deleteChatHistory(chatId, historyKey) {
    const body = state.chats[chatId];
    const liveCount = Array.isArray(body)
        ? body.filter(m => m && !m.isDeleted && !m.isTyping && !m.isSystem).length
        : 0;

    const confirmed = await CastConfirm.ask({
        title: "Delete this chat?",
        message: liveCount
            ? `This chat and its ${liveCount} ${liveCount === 1 ? "message" : "messages"} will be removed.`
            : "This chat will be removed.",
        detail: "Other chats with this character are not affected.",
        confirmText: "Delete chat",
        tone: "danger",
    });

    if (!confirmed) return;

    recordActivity(CastLog.KINDS.CHAT_DELETED, `${liveCount} messages`);

    // Check if this is the currently active chat
    const isActiveChatDeleted = (state.activeChat === chatId);

    // Remove from history
    if (state.chatHistory[historyKey]) {
        state.chatHistory[historyKey] = state.chatHistory[historyKey].filter(entry => entry.id !== chatId);

        // If history is empty for this character, remove the key
        if (state.chatHistory[historyKey].length === 0) {
            delete state.chatHistory[historyKey];
        }

        // Save to storage
        setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);

        // If we deleted the active chat, load another chat
        if (isActiveChatDeleted) {
            // Get the character IDs from the history key
            const characterIds = historyKey.split('-');

            // Find another chat for the same character(s)
            let foundAnotherChat = false;

            // First try to find another chat with the same characters
            if (state.chatHistory[historyKey] && state.chatHistory[historyKey].length > 0) {
                // Sort chats by timestamp, newest first
                const sortedHistory = [...state.chatHistory[historyKey]].sort((a, b) => b.timestamp - a.timestamp);
                if (sortedHistory.length > 0 && sortedHistory[0].id && state.chats[sortedHistory[0].id]) {
                    // Load the most recent chat for this character
                    loadChatFromHistory(sortedHistory[0].id);
                    foundAnotherChat = true;
                    showSuccess("Deleted chat and loaded most recent conversation");
                }
            }

            // If we couldn't find another chat for the same character, create a new one
            if (!foundAnotherChat) {
                // Get the actual character objects based on IDs
                const activeCharacters = state.characters.filter(c => characterIds.includes(c.id));
                if (activeCharacters.length > 0) {
                    // Set active characters and create a new chat
                    state.activeCharacters = activeCharacters.slice(0, 1);
                    createNewChat();
                    showSuccess("Deleted chat and started a new conversation");
                } else {
                    // Clear the active chat since we couldn't find a suitable replacement
                    state.activeChat = null;
                    state.activeCharacters = [];
                    updateChatUI();
                    showError("Chat deleted. Please select a character to start a new conversation.");
                }
            }
        } else {
            // Refresh the history modal
            showChatHistory();

            // Show success message
            showSuccess("Chat history deleted");
        }
    }
}

async function sendMessage() {
    // Ensure we have an active chat
    if (!state.activeChat || !state.chats[state.activeChat]) {
        showError("No active chat. Please select a character to chat with.");
        return;
    }

    // Ensure we have active characters
    if (!state.activeCharacters || state.activeCharacters.length === 0) {
        console.error("No active characters found");
        state.activeCharacters = [];

        // Try to recover which characters this chat belongs to.
        //
        // This was the last place still guessing by splitting the chat ID and keeping
        // any part shorter than ten characters. IDs are twelve characters now, so that
        // test would have discarded every one of them and recovery would always fail.
        const characterIds = getChatCharacterIds(state.activeChat);

        if (characterIds.length > 0) {
            // Recover the characters from the IDs
            console.log("Attempting to recover characters from chat ID:", characterIds);
            state.activeCharacters = characterIds.map(id =>
                state.characters.find(c => c.id === id)
            ).filter(c => c); // Remove any undefined entries

            if (state.activeCharacters.length === 0) {
                showError("Could not recover characters for this chat. Please start a new chat.");
                return;
            }

            console.log("Recovered characters:", state.activeCharacters);
        } else {
            // If we can't recover the characters, suggest creating a new chat
            showError("No characters selected. Please start a new chat.");
            return;
        }
    }

    if (state.activeCharacters.length > 1) {
        state.activeCharacters = [state.activeCharacters[0]];
        state.selectedCharacters = [state.activeCharacters[0].id];
    }

    // If a response is already in progress, prevent sending another message
    if (state.isResponseInProgress) {
        console.log("Response is already in progress, ignoring send request");
        showError("Please wait for the current response to finish before sending another message.");
        return;
    }

    const messageInput = document.getElementById('message-input');
    const userMessage = messageInput.value.trim();

    // Clear input regardless of content
    messageInput.value = '';

    // Set UI to show that a response is in progress
    state.isResponseInProgress = true;
    updateSendButtonState();

    try {
        // Check if we have an empty message
        if (!userMessage) {
            // Check if there's been at least one exchange (user and character) before allowing continue
            const hasExchanges = (() => {
                if (!state.activeChat) return false;
                const messages = state.chats[state.activeChat] || [];
                const userMsgs = messages.filter(m => m.isUser && !m.isDeleted && !m.isContinue);
                const charMsgs = messages.filter(m => !m.isUser && !m.isDeleted && !m.isSystem);

                return userMsgs.length > 0 && charMsgs.length > 0;
            })();

            if (!hasExchanges) {
                showError("Please start the conversation before using the 'continue' feature");
                state.isResponseInProgress = false;
                updateSendButtonState();
                return;
            }

            // Track the current chat ID to ensure we remove the message from the correct chat
            const currentChatId = state.activeChat;

            // For empty messages, add a subtle system message indicating the continue action
            const continueSystemMsg = {
                id: generateUniqueId(),
                content: "...",
                isUser: false,
                isSystem: true,
                timestamp: new Date().toISOString(),
                isDeleted: false
            };

            // Add this subtle indicator to the UI but mark it for auto-removal
            addMessage(continueSystemMsg);

            // Track the system message ID so we can ensure it's removed in cleanup
            let continueSystemMsgId = continueSystemMsg.id;

            // Remove the system message after a short delay or on error
            const removeSystemMessage = () => {
                // Use the stored chatId rather than the possibly changed active chat
                if (state.chats[currentChatId]) {
                    const messages = state.chats[currentChatId];
                    const msgIndex = messages.findIndex(m => m.id === continueSystemMsgId);
                    if (msgIndex !== -1) {
                        messages[msgIndex].isDeleted = true;
                        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

                        // Only update UI if we're still on the same chat
                        if (state.activeChat === currentChatId) {
                            updateChatMessages();
                        }
                    }
                }
            };

            // Set a timeout to remove the message regardless of what happens
            setTimeout(removeSystemMessage, 1500);

            // Get response from each character using async/await and Promise.all for concurrency
            try {
                await Promise.all(state.activeCharacters.map(async (character) => {
                    // Create a special "continue" message that won't be displayed
                    const continueMsg = {
                        id: generateUniqueId(),
                        content: "", // Empty content, just internal signal to continue
                        isUser: true,
                        timestamp: new Date().toISOString(),
                        isDeleted: true, // Mark as deleted so it won't show in the UI
                        isContinue: true // Special flag to mark this as a continue message
                    };

                    // Generate a response without adding the continue message to the visible chat history
                    await getCharacterResponse(character, continueMsg);
                }));

                // Ensure message is removed even if responses complete quickly
                removeSystemMessage();

            } catch (error) {
                // Make sure the system message is cleaned up on error
                removeSystemMessage();
                throw error; // Re-throw to be caught by outer try-catch
            }
        } else {
            // Store current active chat ID to track if user switches chats during response
            const currentChatId = state.activeChat;

            // Add user message
            const userMsg = {
                id: generateUniqueId(),
                content: userMessage,
                isUser: true,
                timestamp: new Date().toISOString(),
                isDeleted: false,
            };

            // Add the user message to the chat
            addMessage(userMsg);

            // Get response from each character using async/await and Promise.all
            await Promise.all(state.activeCharacters.map(character =>
                getCharacterResponse(character, userMsg)
            ));
        }
    } catch (error) {
        console.error("Error sending message:", error);

        // The character answers rather than the app throwing a wall of text at you. The
        // provider's own error is thousands of characters of JSON, and putting that in the
        // banner filled the screen and pushed the message box out of sight.
        const character = state.activeCharacters && state.activeCharacters[0];
        const described = addCharacterUnavailableReply(state.activeChat, character, error);

        // A short banner as well, since the reply might be scrolled out of view.
        showError(described ? described.short : "No reply came back. Please try again.");
    } finally {
        // Each of these is guarded separately. A failure while tidying up used to escape
        // as an unhandled rejection, which showed nothing at all and left the send button
        // stuck disabled.
        try {
            state.isResponseInProgress = false;
            updateSendButtonState();
        } catch (error) {
            console.error("Could not re-enable the send button:", error);
            state.isResponseInProgress = false;
        }

        try {
            updateChatMessages();
        } catch (error) {
            console.error("Could not redraw the conversation:", error);
            showError(`The reply arrived but could not be drawn: ${error.message}. Reloading should show it.`);
        }
    }
}

// Function to update the send button state
function updateSendButtonState() {
    const sendButton = document.getElementById('send-message-btn');
    if (sendButton) {
        if (state.isResponseInProgress) {
            // Disable the button
            sendButton.disabled = true;
            sendButton.classList.add('disabled');
            sendButton.classList.add('opacity-50');
            sendButton.classList.add('cursor-not-allowed');
            sendButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';

            // Also disable the message input
            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.disabled = true;
                messageInput.classList.add('opacity-50');
                messageInput.classList.add('cursor-not-allowed');
                messageInput.placeholder = CastInput.PLACEHOLDER_WAITING;
            }
        } else {
            // Re-enable the button
            sendButton.disabled = false;
            sendButton.classList.remove('disabled');
            sendButton.classList.remove('opacity-50');
            sendButton.classList.remove('cursor-not-allowed');
            sendButton.innerHTML = '<i class="fas fa-paper-plane"></i>';

            // Re-enable the message input
            const messageInput = document.getElementById('message-input');
            if (messageInput) {
                messageInput.disabled = false;
                messageInput.classList.remove('opacity-50');
                messageInput.classList.remove('cursor-not-allowed');
                messageInput.placeholder = CastInput.PLACEHOLDER;
            }
        }
    }
}

function getResponseStatusText(character, startedAt) {
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const providerName = getProviderDisplayName();
    const runningLocally = isLocalProvider();

    if (elapsedSeconds < 5) {
        return `${character.name} is thinking...`;
    }

    if (elapsedSeconds < 15) {
        return `${providerName} is preparing the reply (${elapsedSeconds}s)...`;
    }

    if (runningLocally && elapsedSeconds < 45) {
        return `The model on your machine is still working (${elapsedSeconds}s). The first words can take a while.`;
    }

    return `Still writing (${elapsedSeconds}s). Sending and regenerate are paused until this finishes.`;
}

function updateTypingIndicatorStatus(typingMsgId, statusText) {
    for (const chatId in state.chats) {
        const messages = state.chats[chatId];
        if (!messages) continue;

        const typingMessage = messages.find(m => m.id === typingMsgId);
        if (!typingMessage) continue;

        typingMessage.content = statusText;

        if (chatId === state.activeChat) {
            const messageElement = document.querySelector(`[data-message-id="${typingMsgId}"]`);
            const statusElement = messageElement?.querySelector('.typing-status-text');
            if (statusElement) {
                statusElement.textContent = statusText;
            }

            const messagesContainer = document.getElementById('chat-messages');
            if (messagesContainer) {
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
        }

        return;
    }
}

function startResponseStatusUpdates(typingMsgId, character) {
    const startedAt = Date.now();
    updateTypingIndicatorStatus(typingMsgId, getResponseStatusText(character, startedAt));

    return setInterval(() => {
        updateTypingIndicatorStatus(typingMsgId, getResponseStatusText(character, startedAt));
    }, 3000);
}

function clearResponseStatusUpdates(timerId) {
    if (timerId) {
        clearInterval(timerId);
    }
}
function addMessage(message) {
    // If we have a pending response for a character that's not the active chat
    // Store it in the right chat but don't update the UI
    if (message.characterId && state.pendingResponses[message.characterId]) {
        const chatId = state.pendingResponses[message.characterId].chatId;

        // Make sure the chat exists
        if (!state.chats[chatId]) {
            state.chats[chatId] = [];
        }

        // Add message to the correct chat
        state.chats[chatId].push(message);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);

        // Only update UI if this is for the active chat
        if (chatId === state.activeChat) {
            updateChatMessages();

            if (!message.isTyping) {
                updateSidebarCharacters();

                // Update chat history entry if this is a real message (not typing indicator)
                if (!message.isSystem) {
                    saveCurrentChatToHistory();
                }
            }
        }

        return;
    }

    // Normal flow for active chat
    if (!state.activeChat) return;

    // Add message to chat
    if (!state.chats[state.activeChat]) {
        state.chats[state.activeChat] = [];
    }

    state.chats[state.activeChat].push(message);
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Create the DOM element for the new message
    const messageElement = createMessageHTML(message);
    const messagesContainer = document.getElementById('chat-messages');

    if (messagesContainer && messageElement) {
        // Remove "no messages" placeholder if it exists
        const noMessagesPlaceholder = messagesContainer.querySelector('.text-center.text-gray-500');
        if (noMessagesPlaceholder) {
            noMessagesPlaceholder.remove();
        }
        // Append the new message element
        messagesContainer.appendChild(messageElement);
        // Scroll to the new message
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else if (messagesContainer && !messageElement && (state.chats[state.activeChat]?.length || 0) === 0) {
        // If messageElement is null (e.g. a system message we don't want to render yet)
        // and the chat is empty, ensure the placeholder is shown.
        messagesContainer.innerHTML = `
            <div class="text-center text-gray-500 mt-8">
                <p>No messages yet. Start the conversation!</p>
            </div>
        `;
    } else if (messagesContainer && !messageElement) {
        // If messageElement is null but there are other messages,
        // it might be a non-renderable message, do nothing to the DOM here.
        // updateChatMessages() would be too broad.
    }

    // Update sidebar to reflect new message timestamp
    if (!message.isTyping) {
        updateSidebarCharacters();

        // Update chat history entry if this is a real message (not typing indicator)
        if (!message.isSystem) {
            saveCurrentChatToHistory();
        }
    }
}

async function getCharacterResponse(characterOrId, userMsg) {
    // Always work from the live record.
    //
    // This is what makes an edit take effect on the very next message. The object
    // passed in can be a copy taken when the chat was opened, so reading a
    // description from it could use the version from before the edit. Looking it up
    // again here means the profile sent to the model is always the current one.
    const character = getLiveCharacter(characterOrId);
    if (!character) {
        showError("That character could not be found, so no reply was requested.");
        return;
    }

    // Determine which chat this response belongs to
    const chatId = state.activeChat;

    // Track that we're generating a response for this character in this chat
    state.pendingResponses[character.id] = {
        chatId: chatId,
        isGenerating: true
    };
    let responseStatusTimer = null;

    try {
        // Get visible messages for context (excluding any that are marked as deleted)
        const visibleMessages = state.chats[chatId].filter(m => !m.isDeleted);

        // Check if this is the first message in the conversation
        const isFirstMessage = (() => {
            const characterMessages = visibleMessages.filter(m =>
                !m.isUser &&
                m.characterId === character.id &&
                !m.isSystem &&
                !m.isTyping
            );
            return characterMessages.length === 0;
        })();

        // Check if this is a continue message
        const isContinue = userMsg && userMsg.isContinue === true;

        // Add typing indicator for better UX
        const typingMsg = {
            id: generateUniqueId(),
            content: "",
            isUser: false,
            characterId: character.id,
            timestamp: new Date().toISOString(),
            isTyping: true,
            isDeleted: false
        };

        // Add the typing indicator
        addMessage(typingMsg);
        responseStatusTimer = startResponseStatusUpdates(typingMsg.id, character);

        // Simulate a minimal typing delay based on character and context
        // This makes the interaction feel more natural
        const minTypingDelay = 500; // base minimum delay

        // Calculate a more natural variable typing delay based on message complexity
        // Consider character complexity, previous message length, and a bit of randomness
        const baseDelay = Math.max(minTypingDelay, Math.min(2000, visibleMessages.length * 100));
        const randomVariation = Math.floor(Math.random() * 800) - 400; // -400 to +400ms variation
        const typingDelay = Math.max(minTypingDelay, baseDelay + randomVariation);

        await new Promise(resolve => setTimeout(resolve, typingDelay));

        let promptContext;

        if (isFirstMessage && !isContinue) {
            // For the first message, we include the full character context
            console.log("First message in conversation, using full character context");
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                getChatCharacters(chatId) // the characters actually in this chat
            );

            try {
                // Use a simpler approach for the first message
                const result = await callGeminiAPI(promptContext);

                // Check if we're still generating a response for this character
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Remove typing indicator
                    removeTypingIndicator(typingMsg.id);

                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: result,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
            } catch (error) {
                // Make sure to remove typing indicator even on error
                removeTypingIndicator(typingMsg.id);
                throw error; // Re-throw to be caught by outer try-catch
            }

            return;
        }

        // For subsequent messages, use the conversation history approach with Gemini Chat
        console.log("Using chat history approach for response");

        // Convert visible history for the model.
        //
        // Compaction happens here and nowhere else, so there is exactly one place
        // where what gets sent is decided. If the setting is off, or nothing has
        // been summarised yet, this behaves exactly as it did before.
        const memoryForChat = getChatMemory(chatId);
        const plan = CastMemory.buildSendableHistory({
            messages: visibleMessages,
            memory: memoryForChat,
            settings: appSettings.memory,
            enabled: Boolean(appSettings.memoryCompaction),
        });

        if (plan.recovered) {
            // The summary no longer lines up with the messages, usually because some
            // were deleted. Throw it away and start again rather than send a
            // fragment.
            console.warn("The stored summary no longer matches this chat, so it has been cleared and the full conversation is being sent.");
            clearChatMemory(chatId);
        }

        const history = convertHistoryForGemini(plan.messages, character);

        // Held until the character's instructions have been built further down,
        // since that variable does not exist yet at this point.
        const summaryPreamble = (plan.compacted && plan.summary)
            ? CastMemory.formatSummaryForPrompt(plan.summary, character.name)
            : "";

        // Log the history for debugging
        if (window.debugApp) {
            console.log("History being sent to API:", JSON.stringify(history));
        }

        // Check if history is valid
        if (history.length === 0) {
            console.warn("Empty history after conversion, falling back to basic prompt");
            // Remove typing indicator
            removeTypingIndicator(typingMsg.id);

            // Create a basic prompt instead
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                getChatCharacters(chatId) // the characters actually in this chat
            );

            try {
                // Use a simpler approach as fallback
                const result = await callGeminiAPI(promptContext);

                // Only add the response if we're still responding to the same chat
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: result,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
                return;
            } catch (error) {
                throw new Error("Failed to get response with fallback method: " + error.message);
            }
        }

        // There used to be a block here building an instruction such as "Remember that
        // you are roleplaying as X", which was then sent as the turn. That is why a
        // character could answer the instruction instead of the reader. The character
        // profile is a system instruction now, so no reminder needs sending at all.

        // What actually gets sent as this turn.
        //
        // For an ordinary message this is exactly what the reader typed. The reminder
        // about staying in character now lives in the system instruction, where it
        // belongs, instead of being sent as though the reader had said it.
        let outgoingMessage = "";

        if (userMsg.isInitializing) {
            outgoingMessage = `Introduce yourself briefly, in a way true to your character. Keep it to one or two short paragraphs and leave room for a reply. Do not use my name unless I have already told you it.`;
        } else if (isContinue) {
            // There is no reader message to send, so a nudge is unavoidable here. It is
            // written as a stage direction rather than as speech, so the character has
            // nothing to reply to.
            outgoingMessage = `[Continue the scene yourself, carrying on from your last message. Do not mention this note.]`;
        } else {
            outgoingMessage = String(userMsg.content || "").trim();
            // A blank ordinary message should never reach this point, but if it does,
            // treat it the same as a continue rather than sending nothing at all.
            if (!outgoingMessage) {
                outgoingMessage = `[Continue the scene yourself, carrying on from your last message. Do not mention this note.]`;
            }
        }

        // There used to be a line here appending an instruction that asked the
        // model not to think. It has been removed. A prompt cannot switch off a
        // reasoning pass, so it never worked, and it pushed meta instructions
        // into the character's persona where they did not belong. Reasoning is
        // now kept short through the API's own settings and separated from the
        // reply after it arrives.

        try {
            await ensureAIProviderReady();

            if (getProviderConfig().kind !== CastProviders.KIND.GEMINI) {
                updateTypingIndicatorStatus(typingMsg.id, `${getProviderDisplayName()} is writing...`);

                // The reader's newest message is sent as the final turn, so it must not
                // also appear in the history or the model sees it twice.
                const historyWithoutLatestLocal = history.length && !userMsg.isInitializing
                    ? history.slice(0, -1)
                    : history;
                const localMessages = buildLocalChatMessages(character, historyWithoutLatestLocal, outgoingMessage);
                // callAIChat now separates reasoning from the reply and refuses a
                // response that is nothing but reasoning, so anything that comes
                // back here is real reply text.
                const localResponse = await callAIChat(localMessages, getConversationTokenLimit());

                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    removeTypingIndicator(typingMsg.id);
                    addMessage({
                        id: generateUniqueId(),
                        content: localResponse,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }

                console.log(`${getProviderDisplayName()} reply complete, ${localResponse.length} characters.`);

                maybeCompactChat(chatId, character).catch(error => {
                    console.warn("Summarising after the reply did not work:", error);
                });
                return;
            }
            // Create a chat with the history using the Gemini SDK.
            const modelName = getModelFor("gemini");
            const generationConfig = CastProviders.buildGeminiConfig({
                model: modelName,
                maxTokens: getConversationTokenLimit(),
                temperature: appSettings.temperature,
            });

            // The character's whole profile goes in as a system instruction.
            //
            // This is the fix for a character seeming to lose the thread. Before, the
            // profile was only sent on the very first message, and every turn after
            // that ended by sending a reminder as though the reader had typed it. So
            // the model saw the reader's message, then a separate turn saying
            // "Remember that you are roleplaying as X", and it answered the reminder
            // instead of the reader. With a short message like "ok" the reminder was
            // the most substantial thing in front of it, which is why the reply came
            // back explaining who the character was rather than responding.
            //
            // The profile now sits where instructions belong, and the message sent is
            // what the reader actually wrote.
            generationConfig.systemInstruction = prepareContextForAPI(
                character,
                [],
                getChatCharacters(chatId)
            );
            if (summaryPreamble) {
                generationConfig.systemInstruction += `\n\n${summaryPreamble}`;
            }

            console.log("Creating Gemini chat with model:", modelName);

            // The reader's newest message is sent separately, so it must not also be
            // in the history or the model would see it twice.
            const historyWithoutLatest = history.length && !userMsg.isInitializing
                ? history.slice(0, -1)
                : history;

            const chat = state.genaiClient.chats.create({
                model: modelName,
                history: historyWithoutLatest,
                config: generationConfig,
            });

            // Prepare for the new response, but do not create a blank bubble before text arrives.
            let fullResponse = "";
            let responseMsg = null;
            // Determine typing speed based on character personality
            // This makes characters with verbose personalities type slower than terse ones
            const baseCharSpeed = character.enhancedContext ?
                (character.enhancedContext.includes("talkative") ||
                    character.enhancedContext.includes("verbose") ? 30 : 50) : 40;

            // Track the last update time for natural typing simulation
            let lastUpdateTime = Date.now();
            // let accumulatedText = ""; // Replaced by accumulatedRawResponse for clarity
            let accumulatedRawResponse = ""; // Accumulates raw text for final state update & processing

            // Function to simulate natural typing behavior - RETHINKING THIS
            // The main streaming loop will call updateMessageContent directly.
            // We don't strictly need updateWithTypingEffect anymore if logic is in the main loop.

            try {
                console.log("Sending message stream...");
                const result = await chat.sendMessageStream({ message: outgoingMessage });

                // Reasoning is filtered as the stream arrives. The filter holds
                // back anything that might turn out to be the start of a tag, so
                // a tag split across two chunks can never leak into the bubble.
                // That was the cause of the reasoning showing up mid reply.
                const reasoningFilter = CastThinking.createStreamFilter();
                let sawTruncation = false;

                for await (const chunk of result) {
                    if (!state.pendingResponses[character.id] || state.pendingResponses[character.id].chatId !== chatId) {
                        break; // The reader moved to a different chat.
                    }

                    // Read the chunk properly rather than trusting a combined
                    // text field. On Gemini, parts flagged as thoughts are
                    // reasoning, and the combined field can include them.
                    const piece = CastThinking.readChunk(chunk);
                    if (piece.finishReason) {
                        const reason = piece.finishReason.toUpperCase();
                        if (reason === "MAX_TOKENS" || reason === "LENGTH") sawTruncation = true;
                    }
                    if (!piece.replyText && !piece.reasoningText) continue;

                    // Anything the provider already told us is reasoning is set
                    // aside without ever going near the bubble.
                    const visible = reasoningFilter.consume(piece.replyText);
                    if (!visible) continue;

                    // The bubble is only created once there is real reply text to
                    // put in it, so a response that is all reasoning never leaves
                    // an empty bubble behind.
                    if (!responseMsg) {
                        removeTypingIndicator(typingMsg.id);
                        responseMsg = {
                            id: generateUniqueId(),
                            content: "",
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false,
                        };
                        addMessage(responseMsg);
                    }

                    updateMessageContent(responseMsg.id, visible, false);
                    accumulatedRawResponse += visible;
                    fullResponse = accumulatedRawResponse;
                }

                const streamResult = reasoningFilter.finish();
                if (streamResult.tail && responseMsg) {
                    updateMessageContent(responseMsg.id, streamResult.tail, false);
                    accumulatedRawResponse += streamResult.tail;
                }

                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    const verdict = CastThinking.verifyReply({
                        reply: accumulatedRawResponse,
                        reasoning: streamResult.reasoning,
                        truncated: sawTruncation,
                        endedInsideReasoning: streamResult.endedInsideReasoning,
                    });

                    if (verdict.ok) {
                        const finalMessageInState = (state.chats[chatId] || []).find(m => m.id === responseMsg.id);
                        if (finalMessageInState) {
                            finalMessageInState.content = verdict.reply;
                            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
                        }
                        updateMessageContent(responseMsg.id, verdict.reply, true);
                    } else {
                        // The model reasoned and never got to a reply. Rather than
                        // save the reasoning as though the character had said it,
                        // remove the empty bubble and explain what happened.
                        if (responseMsg) {
                            deleteMessagePermanently(chatId, responseMsg.id);
                            responseMsg = null;
                        }
                        removeTypingIndicator(typingMsg.id);
                        showError(verdict.message);
                        if (streamResult.reasoning) {
                            console.log("The model produced only reasoning:", streamResult.reasoning.substring(0, 200));
                        }
                    }
                }
                console.log("Reply complete,", accumulatedRawResponse.length, "characters. Reasoning set aside:", streamResult.reasoning.length, "characters.");

                // Now that the reader has their reply, consider summarising the
                // older part of this chat. Deliberately after delivery, so it can
                // never make a message slower or interfere with one.
                maybeCompactChat(chatId, character).catch(error => {
                    console.warn("Summarising after the reply did not work:", error);
                });
            } catch (error) {
                console.error("Stream error:", error);
                // If streaming fails, try to process and display what was received, or an error message.
                if (state.pendingResponses[character.id] &&
                    state.pendingResponses[character.id].chatId === chatId) {

                    if (fullResponse.length < 10) {
                        // If we've barely started, try to get at least something to display
                        try {
                            const emergencyResponse = await callGeminiAPI(
                                `As ${character.name}, please respond to: "${userMsg.content || 'Continue the conversation'}" (Keep it brief and in character)`
                            );
                            if (!responseMsg) {
                                removeTypingIndicator(typingMsg.id);
                                addMessage({
                                    id: generateUniqueId(),
                                    content: emergencyResponse,
                                    isUser: false,
                                    characterId: character.id,
                                    timestamp: new Date().toISOString(),
                                    isDeleted: false,
                                });
                            } else {
                                updateMessageContent(responseMsg.id, emergencyResponse, true);
                            }
                        } catch (fallbackError) {
                            // If even that fails, add an apologetic message
                            if (!responseMsg) {
                                removeTypingIndicator(typingMsg.id);
                                addMessage({
                                    id: generateUniqueId(),
                                    content: `*${character.name} seems unable to respond at the moment*`,
                                    isUser: false,
                                    characterId: character.id,
                                    timestamp: new Date().toISOString(),
                                    isDeleted: false,
                                });
                            } else {
                                updateMessageContent(responseMsg.id, `*${character.name} seems unable to respond at the moment*`, true);
                            }                        }
                    }
                }
                throw error; // Still throw the error for the outer catch block
            }
        } catch (error) {
            // Only handle specific API errors if this response is still relevant
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {

                if (error.message && error.message.includes('First content should be with role')) {
                    console.error("History format error:", error.message);

                    // Try a simplified approach
                    removeTypingIndicator(typingMsg.id);

                    // Add a system message
                    addMessage({
                        id: generateUniqueId(),
                        content: "Trying a different approach to get a response...",
                        isUser: false,
                        isSystem: true,
                        timestamp: new Date().toISOString(),
                        isDeleted: false
                    });

                    // Create a new empty typing indicator
                    const newTypingMsg = {
                        id: generateUniqueId(),
                        content: "",
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isTyping: true,
                        isDeleted: false
                    };

                    // Add it
                    addMessage(newTypingMsg);

                    // Small delay
                    await new Promise(resolve => setTimeout(resolve, 500));

                    try {
                        // Try a direct prompt approach instead
                        const promptContext = prepareContextForAPI(
                            character,
                            visibleMessages.slice(-5), // Use only the last 5 messages to reduce context
                            getChatCharacters(chatId)
                        );

                        const result = await callGeminiAPI(promptContext + `\nRespond as ${character.name} to the last message from the user: "${userMsg.content || 'Continue the conversation naturally'}"`);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        // Add response
                        addMessage({
                            id: generateUniqueId(),
                            content: result,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false
                        });

                        return;
                    } catch (fallbackError) {
                        console.error("Fallback attempt also failed:", fallbackError);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        // Add error message
                        addMessage({
                            id: generateUniqueId(),
                            content: `*${character.name} is unable to respond right now*`,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false
                        });
                    }
                } else {
                    console.error("API error:", error);
                    showError(`Failed to get response: ${error.message}`);
                }
            }
        } finally {
            clearResponseStatusUpdates(responseStatusTimer);
            // Clean up the pending response status when done
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {
                state.pendingResponses[character.id].isGenerating = false;
            }
        }
    } catch (error) {
        clearResponseStatusUpdates(responseStatusTimer);
        console.error("Error in getCharacterResponse:", error);

        if (state.pendingResponses[character.id] &&
            state.pendingResponses[character.id].chatId === chatId) {
            state.pendingResponses[character.id].isGenerating = false;
        }

        // Tidy up anything left mid flight, so a failure does not leave a typing
        // indicator spinning forever.
        try { removeTypingIndicator(typingMsg && typingMsg.id); } catch (cleanupError) { /* nothing useful to do */ }

        // Handed back to the caller.
        //
        // This used to be swallowed here. The error was logged and then the function
        // returned as though nothing had happened, so the code that reports a failure to
        // you never ran. That is why a rate limit produced complete silence: it was
        // caught, written to the console, and dropped.
        throw error;
    }
}

// Turns a reply into what you see.
//
// The emphasis handling that used to live here was one regular expression that ran
// before the markdown parser. It could not see double asterisks, it matched across
// blank lines, and so a single **bold** left a stray marker that paired with the
// opening marker of the next action line. From that point on, italics were inverted
// for the rest of the message and asterisks showed up on screen.
//
// It all lives in src/markdown.js now, where it is tested against the message that
// exposed the problem. DOMPurify still runs over the result, because two layers of
// protection on model output is the right number.
const processContent = (content) => {
    const html = CastMarkdown.toHtml(content);
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['em', 'strong', 'code', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'],
        ALLOWED_ATTR: ['class'],
    });
};

// The same thing, for a reply that is still arriving. A marker that has not been
// closed yet is normal mid stream rather than a mistake, so it is held back instead
// of being shown as a literal asterisk that then turns into italics.
const processStreamingContent = (content) => {
    const html = CastMarkdown.toHtmlForStreaming(content);
    return DOMPurify.sanitize(html, {
        ALLOWED_TAGS: ['em', 'strong', 'code', 'br', 'p', 'ul', 'ol', 'li', 'blockquote', 'i', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr', 'del', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span'],
        ALLOWED_ATTR: ['class'],
    });
};

// Helper function to update message content
function updateMessageContent(messageId, newContent, isFinalUpdate = false) {
    const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
    const messagesContainer = document.getElementById('chat-messages');

    if (messageElement) {
        const textContentElement = messageElement.querySelector('.message-text-content');
        if (textContentElement) {
            if (!isFinalUpdate) {
                // While the reply is arriving, keep the raw text on the element and
                // render the whole of it each time. The old version appended the raw
                // chunk straight into the page, so asterisks were visible mid reply
                // and then rearranged themselves into italics at the end, which
                // looked like a glitch.
                const accumulated = (textContentElement.dataset.rawContent || "") + newContent;
                textContentElement.dataset.rawContent = accumulated;
                textContentElement.innerHTML = processStreamingContent(accumulated);

                if (messagesContainer) {
                    messagesContainer.scrollTop = messagesContainer.scrollHeight; // Scroll down
                }
            } else { // Final update, streaming complete
                textContentElement.dataset.rawContent = newContent;
                textContentElement.innerHTML = processContent(newContent); // Process full raw content
            }
        } else {
            console.warn(`.message-text-content not found for messageId: ${messageId}`);
        }
    } else {
        // If the message element doesn't exist yet (e.g., initial addMessage call for a streaming response)
        // this function might be called. addMessage should handle creating the initial element.
        // This specific call to updateMessageContent might be for a message not yet in DOM or for background.
        console.warn(`Message element with ID ${messageId} not found in DOM for content update.`);
    }

    // Update message content in state.
    // For streaming, newContent is a chunk. For final, it's the full raw response.
    // The state should always store the raw, unprocessed content.
    let messageUpdatedInState = false;
    for (const chatId in state.chats) {
        if (state.chats[chatId]) {
            const messageIndex = state.chats[chatId].findIndex(m => m.id === messageId);
            if (messageIndex !== -1) {
                if (!isFinalUpdate) {
                    // If it's the first chunk for a message that was previously empty
                    if (state.chats[chatId][messageIndex].content === "") {
                        state.chats[chatId][messageIndex].content = newContent;
                    } else {
                        state.chats[chatId][messageIndex].content += newContent;
                    }
                } else {
                    state.chats[chatId][messageIndex].content = newContent; // Set the final raw content
                }
                // Save to localStorage only on final update to avoid frequent writes during streaming.
                if (isFinalUpdate) {
                    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
                }
                messageUpdatedInState = true;
                break;
            }
        }
    }
    if (!messageUpdatedInState) {
        console.warn(`Message with ID ${messageId} not found in state for content update.`);
    }
}


// Removes a message completely, used when a reply turned out to be nothing but
// the model's reasoning and so was never something the character said.
//
// This is different from the delete button, which marks a message as deleted and
// keeps it. Here the message should never have existed in the first place.
function deleteMessagePermanently(chatId, messageId) {
    const messages = state.chats[chatId];
    if (!Array.isArray(messages)) return;

    const index = messages.findIndex(m => m && m.id === messageId);
    if (index !== -1) {
        messages.splice(index, 1);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    }

    const element = document.querySelector(`[data-message-id="${messageId}"]`);
    if (element && element.parentNode) {
        element.parentNode.removeChild(element);
    }
}

// --- Conversation memory ---
//
// Each chat can have a summary of its older part. It is kept separately from the
// messages, which are never touched, so turning the setting off restores the full
// conversation immediately.

function getChatMemory(chatId) {
    if (!state.chatMemory || typeof state.chatMemory !== 'object') state.chatMemory = {};
    return state.chatMemory[chatId] || {};
}

function setChatMemory(chatId, memory) {
    if (!state.chatMemory) state.chatMemory = {};
    state.chatMemory[chatId] = memory;
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory);
}

function clearChatMemory(chatId) {
    if (!state.chatMemory) return;
    delete state.chatMemory[chatId];
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory);
}

// Summarises the older part of a chat, if it is worth doing.
//
// Runs after a reply has been delivered, never before, so it can never delay a
// message or interfere with one. If anything fails, the chat carries on sending its
// full history. Failing here costs more tokens and nothing else.
async function maybeCompactChat(chatId, character) {
    if (!appSettings.memoryCompaction) return;
    if (!chatId || !character) return;
    if (state.isCompacting) return; // one at a time

    const messages = state.chats[chatId];
    if (!Array.isArray(messages)) return;

    const memory = getChatMemory(chatId);
    const decision = CastMemory.shouldCompact({
        messages,
        memory,
        settings: appSettings.memory,
        enabled: true,
    });

    if (!decision.compact) return;

    const plan = CastMemory.planCompaction({ messages, memory, settings: appSettings.memory });
    if (!plan.toSummarise.length) return;

    state.isCompacting = true;
    showCompactionNotice(true);

    try {
        const prompt = CastMemory.buildSummaryPrompt({
            characterName: character.name,
            userName: state.personalContext.name,
            previousSummary: plan.previousSummary,
            messages: plan.toSummarise,
        });

        // Given its own generous limit, because a cramped summary is a bad summary
        // and this only happens occasionally.
        const summary = await callAIText(prompt, 2048);

        const check = CastMemory.isUsableSummary(summary, { foldedMessages: plan.toSummarise });
        if (!check.ok) {
            console.warn(`The summary was not usable (${check.reason}), so the full conversation will keep being sent.`);
            setChatMemory(chatId, CastMemory.recordFailure(memory, check.reason));
            return;
        }

        setChatMemory(chatId, CastMemory.recordSuccess(memory, {
            summary: summary.trim(),
            coveredCount: plan.newCoveredCount,
            messageCount: plan.toSummarise.length,
        }));

        recordActivity(CastLog.KINDS.SUMMARY_MADE, `${plan.toSummarise.length} messages folded in, was roughly ${decision.tokens} tokens a turn`);
        console.log(`Summarised ${plan.toSummarise.length} older messages in this chat. Roughly ${decision.tokens} tokens a turn before.`);
        updateMemoryPanel();
    } catch (error) {
        console.warn("Summarising did not work this time:", error.message);
        setChatMemory(chatId, CastMemory.recordFailure(memory, error.message));
    } finally {
        state.isCompacting = false;
        showCompactionNotice(false);
    }
}

// A small, quiet indicator. Compaction should be visible but not alarming.
function showCompactionNotice(active) {
    const notice = document.getElementById('compaction-notice');
    if (!notice) return;
    notice.classList.toggle('hidden', !active);
}

// Helper function to find the typing indicator and remove it
function removeTypingIndicator(typingMsgId) {
    // Check if this is a pending response in background
    for (const characterId in state.pendingResponses) {
        const pendingData = state.pendingResponses[characterId];
        const chatId = pendingData.chatId;

        if (chatId && state.chats[chatId]) {
            const messages = state.chats[chatId];
            const typingIndex = messages.findIndex(m => m.id === typingMsgId);

            if (typingIndex !== -1) {
                messages.splice(typingIndex, 1);
                setStoredItem(STORAGE_KEYS.CHATS, state.chats);

                // Only update UI if this is for the active chat
                if (chatId === state.activeChat) {
                    updateChatMessages();
                }

                return;
            }
        }
    }

    // Normal flow for active chat
    if (!state.activeChat) return;

    const messages = state.chats[state.activeChat];
    const typingIndex = messages.findIndex(m => m.id === typingMsgId);

    if (typingIndex !== -1) {
        messages.splice(typingIndex, 1);
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        updateChatMessages();
    }
}

// Context preparation for chat
function prepareContextForAPI(character, chatHistory, activeCharacters = []) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.conversationTokens * 0.75);

    // Base context with character information and roleplay instructions
    let context = `You are ${character.name}. You must maintain your character's personality and traits at all times.

CHARACTER PROFILE:
${character.enhancedContext
            ? character.enhancedContext
            : character.userContext}

${state.personalContext.name || state.personalContext.personality || state.personalContext.context ? `ABOUT THE PERSON YOU ARE TALKING TO:
${state.personalContext.name ? `Their name is ${state.personalContext.name}. Always use their name when appropriate.` : ''}
${state.personalContext.personality ? `\nTheir personality: ${state.personalContext.personality}` : ''}
${state.personalContext.context ? `\nAdditional context about them: ${state.personalContext.context}` : ''}\n` : ''}

ROLEPLAY GUIDELINES:
- Stay in character at all times - you ARE ${character.name}
- Never break character or mention being an AI
- Do not output visible thinking, chain-of-thought, or <think> sections; reply directly and fully in character
- Respond naturally based on your character's personality and the user's known traits
- Use natural conversational language and emotional responses
- If the user has shared their name or traits, incorporate these naturally into your responses
- For empty messages (continue), advance the conversation naturally while staying in character
- Maintain continuity with previous messages and scene
- Use *single asterisks* for actions, gestures and thoughts, and **double asterisks** to stress a word. This is ordinary markdown, which is what you already write naturally.
- Put each action on its own line, with a blank line around it, so it reads separately from speech.
- Use ## on its own line for a change of scene.
- You can read text in brackets as thoughts or context.
- If the user wants to end the conversation/roleplay by saying e.g. "The End", you can say naturally to your character "Goodbye!" or "It was nice talking to you!" or "It was fun roleplaying with you!"`;

    // Add conversation history with smart context management
    if (chatHistory.length > 0) {
        const relevantMessages = chatHistory.filter(msg => !msg.isDeleted && !msg.isTyping);

        if (relevantMessages.length > 0) {
            // Always include the first exchange to maintain the conversation's origin
            const firstExchange = relevantMessages.slice(0, 2);

            // Get the most recent messages
            const recentMessages = relevantMessages.slice(-5);

            // If we have a long conversation, add a summary of key points
            if (relevantMessages.length > 7) {
                // Add first exchange
                context += "\n\nCONVERSATION START:\n" + firstExchange.map(msg => {
                    if (msg.isUser) {
                        return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                    } else if (msg.characterId === character.id) {
                        return `${character.name}: ${msg.content}`;
                    }
                }).join('\n');

                // Add a transition
                context += "\n\n[Several messages exchanged, maintaining the conversation's flow and themes...]\n\n";
            }

            // Add recent messages
            context += "RECENT CONVERSATION:\n" + recentMessages.map(msg => {
                if (msg.isUser) {
                    return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                } else if (msg.characterId === character.id) {
                    return `${character.name}: ${msg.content}`;
                } else {
                    const msgCharacter = state.characters.find(c => c.id === msg.characterId);
                    return msgCharacter ? `${msgCharacter.name}: ${msg.content}` : `Unknown: ${msg.content}`;
                }
            }).join('\n');
        }
    }

    return context;
}

// Convert history to the format expected by Gemini API
function convertHistoryForGemini(chatHistory, currentCharacter) {
    const formattedHistory = [];
    let hasUserMessage = false;

    // First, check if there's at least one user message in the history
    for (const msg of chatHistory) {
        if (msg.isUser && !msg.isDeleted && !msg.isContinue) {
            hasUserMessage = true;
            break;
        }
    }

    // If no user messages, create a natural conversation starter
    if (!hasUserMessage) {
        const greeting = state.personalContext.name
            ? `Hello ${state.personalContext.name}`
            : "Hello";

        formattedHistory.push({
            role: "user",
            parts: [{ text: greeting }]
        });
        return formattedHistory;
    }

    // Filter relevant messages
    const relevantMessages = chatHistory.filter(msg => {
        if (msg.isTyping || (msg.isDeleted && !msg.isContinue)) return false;
        if (msg.isContinue) return false;
        // A note saying the character was unavailable is not something they said in the
        // story, so it must not be sent back to them as though it were.
        if (msg.isError) return false;
        return msg.isUser || msg.characterId === currentCharacter.id || msg.characterId;
    });

    // Process messages
    let lastRole = null;
    let combinedUserMessage = "";

    for (let i = 0; i < relevantMessages.length; i++) {
        const msg = relevantMessages[i];

        if (msg.isUser) {
            if (lastRole === "user" && combinedUserMessage) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = msg.content;
            } else {
                combinedUserMessage = msg.content;
                lastRole = "user";
            }

            if (i === relevantMessages.length - 1 || !relevantMessages[i + 1].isUser) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = "";
            }
        } else if (msg.characterId === currentCharacter.id) {
            formattedHistory.push({
                role: "model",
                parts: [{ text: msg.content }]
            });
            lastRole = "model";
            combinedUserMessage = "";
        } else if (msg.characterId) {
            const otherCharacter = state.characters.find(c => c.id === msg.characterId);
            const characterName = otherCharacter ? otherCharacter.name : "Another character";
            formattedHistory.push({
                role: "user",
                parts: [{ text: `[${characterName}] ${msg.content}` }]
            });
            lastRole = "user";
            combinedUserMessage = "";
        }
    }

    // Ensure history ends with user message if needed
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === "model") {
        formattedHistory.push({
            role: "user",
            parts: [{
                text: state.personalContext.name
                    ? `(${state.personalContext.name} continues listening)`
                    : "(continue the conversation)"
            }]
        });
    }

    return formattedHistory; // fixed bug: Error getting character response: TypeError: Assignment to constant variable. at convertHistoryForGemini
    // Error sending message: ReferenceError: typingMsg is not defined at getCharacterResponse
}

// Quick test function to directly open chat window for testing
function forceOpenChat() {
    console.log("Force opening chat window for testing");

    // Create a test character if none exists
    if (state.characters.length === 0) {
        const testCharacter = {
            id: "test-character",
            name: "Test Character",
            userContext: "This is a test character created automatically for testing the chat interface.",
            enhancedContext: null,
            createdAt: new Date().toISOString()
        };
        state.characters.push(testCharacter);
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);
        updateCharacterLists();
    }

    // Select the first character
    state.selectedCharacters = [state.characters[0].id];
    state.activeCharacters = [state.characters[0]];

    // Set active chat
    const chatId = state.selectedCharacters[0];
    state.activeChat = chatId;

    // Ensure chat exists in state
    if (!state.chats[chatId]) {
        state.chats[chatId] = [];
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    }

    // Switch to chat view
    changeView('chat');

    // Force UI update directly - don't rely on changeView
    console.log("Directly updating chat UI");

    // Hide placeholder, show chat window
    const placeholder = document.getElementById('chat-placeholder');
    const chatWindow = document.getElementById('chat-window');

    if (placeholder) {
        placeholder.classList.add('hidden');
        console.log("Placeholder hidden");
    } else {
        console.warn("Chat placeholder not found");
    }

    if (chatWindow) {
        chatWindow.classList.remove('hidden');
        console.log("Chat window shown");
    } else {
        console.warn("Chat window not found");
    }

    // Update chat header
    const headerTitle = document.getElementById('chat-header-title');
    if (headerTitle) headerTitle.textContent = state.characters[0].name;

    const headerSubtitle = document.getElementById('chat-header-subtitle');
    if (headerSubtitle) {
        const apiStatus = state.isApiConnected ? `${getProviderDisplayName()} connected` : `${getProviderDisplayName()} not connected`;
        headerSubtitle.textContent = `Conversation - ${apiStatus}`;
    }

    // Add a welcome message based on API status
    let welcomeMessage = "";

    if (state.isApiConnected) {
        welcomeMessage = `Welcome to the chat! ${getProviderDisplayName()} is connected and ready.`;
    } else {
        welcomeMessage = `Welcome to the chat! Configure and test ${getProviderDisplayName()} in Settings to receive AI-generated responses.`;
    }

    // Reset existing messages
    state.chats[chatId] = [];

    const welcomeMsg = {
        id: generateUniqueId(),
        content: welcomeMessage,
        isUser: false,
        characterId: state.characters[0].id,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    };

    // Add message to chat
    addMessage(welcomeMsg);

    // Try to connect API if key exists but connection failed
    if (isProviderConfigured() && !state.isApiConnected) {
        initializeAIProvider().then(success => {
            if (success) {
                // Update header with new status
                if (headerSubtitle) {
                    headerSubtitle.textContent = `Conversation - ${getProviderDisplayName()} connected`;
                }

                // Add a success message
                addMessage({
                    id: generateUniqueId(),
                    content: `${getProviderDisplayName()} connection successful! Your messages will now receive AI-generated responses.`,
                    isUser: false,
                    characterId: state.characters[0].id,
                    timestamp: new Date().toISOString(),
                    isDeleted: false,
                });
            }
        }).catch(error => {
            console.error("Error connecting to API:", error);
        });
    }
}

// API communication
async function callGeminiAPI(prompt) {
    try {
        return await callAIText(prompt, appSettings.enhancedContextTokens || appSettings.maxTokens);
    } catch (error) {
        console.error(`${getProviderDisplayName()} API call failed:`, error);
        state.isApiConnected = false;
        checkApiKey();
        throw error;
    }
}

async function enhanceCharacterContext(characterId) {
    if (!isProviderConfigured()) {
        showError(getProviderConfigurationMessage());
        return;
    }

    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("Character not found");
        return;
    }

    // Find the enhance button directly - don't rely on previous selectors
    const enhanceButton = document.querySelector(`#enhance-btn-${characterId}`);
    if (enhanceButton) {
        // Visually update the button
        enhanceButton.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Enhancing...';
        enhanceButton.disabled = true;
    } else {
        console.warn(`Enhance button for character ${characterId} not found`);
    }

    // Ensure API is initialized
    if (!state.isApiConnected) {
        try {
            const initialized = await initializeGeminiAPI();
            if (!initialized) {
                showError(`Failed to connect to ${getProviderDisplayName()}. Please check your provider settings.`);
                resetEnhanceButton(enhanceButton);
                return;
            }
        } catch (error) {
            showError(`API initialization failed: ${error.message}`);
            resetEnhanceButton(enhanceButton);
            return;
        }
    }

    // Call API
    try {
        const enhancedContext = await callEnhanceAPI(character.name, character.userContext);

        // Write to the live record, not to whatever copy was handed in, otherwise the
        // enhanced profile is saved onto an object nothing else is looking at.
        const live = getLiveCharacter(character) || character;
        live.enhancedContext = enhancedContext;
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

        // Show success message
        recordActivity(CastLog.KINDS.CHARACTER_ENHANCED, `${character.name}, ${enhancedContext.length} characters`);
        showSuccess(`Character ${character.name} has been enhanced!`);

        // Update the container of this specific character if it exists
        const characterItem = document.getElementById(`character-item-${characterId}`);
        if (characterItem) {
            // Find or create enhanced context container
            let enhancedContainer = characterItem.querySelector('.enhanced-context');
            if (!enhancedContainer) {
                enhancedContainer = document.createElement('div');
                enhancedContainer.className = 'mt-3 bg-gray-50 p-2 rounded enhanced-context';

                // Insert before the button container
                const buttonContainer = characterItem.querySelector('.mt-3');
                if (buttonContainer) {
                    characterItem.insertBefore(enhancedContainer, buttonContainer);
                } else {
                    characterItem.appendChild(enhancedContainer);
                }
            }

            // Update the content
            enhancedContainer.innerHTML = `
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${enhancedContext}
                </div>
            `;

            // Reset the enhance button
            resetEnhanceButton(enhanceButton, "Re-Enhance Context");
        } else {
            // If we can't find the individual item, update the whole list
            const characterListContainer = document.getElementById('character-list');
            if (characterListContainer) {
                characterListContainer.innerHTML = generateCharacterListHTML();
            }
            resetEnhanceButton(enhanceButton);
        }
    } catch (error) {
        console.error("Error enhancing character:", error);
        showError(`Failed to enhance character: ${error.message}`);
        resetEnhanceButton(enhanceButton);
    }
}

// Helper function to reset enhance button
function resetEnhanceButton(button, text = 'Enhance Context') {
    if (button) {
        button.innerHTML = `<i class="fas fa-magic mr-1"></i> ${text}`;
        button.disabled = false;
    }
}

// Success message function
function showSuccess(message, duration = 3000) {
    // Goes through the same place as everything else, so it looks the same and takes
    // itself away like everything else.
    notify(message, 'success');
}

async function callEnhanceAPI(characterName, userContext) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.enhancedContextTokens * 0.75);

    const prompt = `
You are an expert character developer for roleplaying. Transform this brief character description into a detailed character profile that can guide an AI in consistently roleplaying as this character.
Fill in the details about but dont sound like the character, because this is for generating a character context which will be used to roleplay with the user. Importantly do not have a starting message at
all, like for example Here's a comprehensive character profile of the character, designed to guide..... Do not do that!!!  Just start providing the character profile without any confirmation.
CHARACTER NAME: "${characterName}"

BRIEF DESCRIPTION (that user provided that needs to be enhanced with more critical details):
"${userContext}"

CREATE A COMPREHENSIVE CHARACTER PROFILE INCLUDING:
1. Personality traits with specific behavioral examples
2. Distinctive speech patterns, vocabulary choices, and verbal tics
3. Background information and formative experiences that shaped them
4. Core motivations, values, and life goals
5. Key relationships and how they interact with different types of people
6. Emotional responses to various situations (angry, happy, stressed, etc.)
7. Physical appearance and mannerisms if relevant
8. Skills, knowledge areas, and expertise
9. Fears, insecurities, and internal conflicts

FORMAT AS A COHESIVE PROFILE THAT DEFINES THE CHARACTER'S ESSENCE.
- Make the character feel authentic and three-dimensional with consistent traits.
- Include specific examples of how they would speak and react.
- Write in third person.
- IMPORTANT: Your response MUST be approximately ${wordLimit} words or fewer to fit within the token limit of ${appSettings.enhancedContextTokens} tokens. Focus on depth and specificity rather than length.
`;

    try {
        // Use the regular callGeminiAPI function which already uses appSettings
        const result = await callGeminiAPI(prompt);
        return result;
    } catch (error) {
        console.error("Error enhancing character:", error);
        throw error;
    }
}

async function deleteCharacter(characterId) {
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("That character could not be found.");
        return false;
    }

    // Work out what is actually about to be lost, so the question is specific
    // rather than a vague are you sure. Losing a character also loses every chat
    // with them, which was not obvious before.
    const affectedChats = Object.keys(state.chats).filter(chatId =>
        chatBelongsToCharacter(chatId, characterId)
    );
    let messageCount = 0;
    affectedChats.forEach(chatId => {
        const body = state.chats[chatId];
        if (Array.isArray(body)) messageCount += body.filter(m => m && !m.isDeleted).length;
    });

    const parts = [];
    if (affectedChats.length) {
        parts.push(`${affectedChats.length} ${affectedChats.length === 1 ? "chat" : "chats"}`);
    }
    if (messageCount) {
        parts.push(`${messageCount} ${messageCount === 1 ? "message" : "messages"}`);
    }

    const confirmed = await CastConfirm.ask({
        title: `Delete ${character.name}?`,
        message: parts.length
            ? `This also deletes ${parts.join(" and ")} with them. It cannot be undone.`
            : "This cannot be undone.",
        detail: parts.length ? "Save a backup first if you might want any of this back." : "",
        confirmText: "Delete",
        tone: "danger",
    });

    if (!confirmed) return false;

    recordActivity(CastLog.KINDS.CHARACTER_DELETED, `${character.name}, with ${affectedChats.length} of their chats`);
    return performCharacterDeletion(characterId);
}

// The actual removal, kept separate from the asking so the confirmation cannot
// accidentally be skipped by a future caller reaching for the wrong function.
function performCharacterDeletion(characterId) {
    console.log("Deleting character:", characterId);

    // Remove from characters array
    state.characters = state.characters.filter(c => c.id !== characterId);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Remove from selected characters
    state.selectedCharacters = state.selectedCharacters.filter(id => id !== characterId);

    // Remove from active characters if present
    if (state.activeCharacters) {
        state.activeCharacters = state.activeCharacters.filter(c => c.id !== characterId);
    }

    // Remove from last active chats
    if (state.lastActiveChats[characterId]) {
        delete state.lastActiveChats[characterId];
        setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);
    }

    // Remove associated chats.
    //
    // This used to ask whether the character's ID appeared anywhere inside the
    // chat ID as plain text. That is not the same question as whether the chat
    // belongs to the character, and it was being used to decide what to delete.
    // It now checks recorded membership instead.
    let chatsRemoved = 0;
    Object.keys(state.chats).forEach(chatId => {
        if (chatBelongsToCharacter(chatId, characterId)) {
            delete state.chats[chatId];
            delete state.chatMembers[chatId];
            if (state.chatMemory) delete state.chatMemory[chatId];
            chatsRemoved++;
        }
    });
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    setStoredItem(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory || {});

    // Remove the picture too, so it is not left behind taking up space.
    CastImages.deletePicture(characterId).catch(() => {});
    delete state.pictureCache[characterId];

    console.log(`Character deleted, along with ${chatsRemoved} of their chats.`);

    // Remove the HTML element directly
    const charElement = document.getElementById(`character-item-${characterId}`);
    if (charElement) {
        charElement.remove();
    }

    // Optionally, update the sidebar if needed
    updateSidebarCharacters();

    // Show success message
    showSuccess("Character deleted.");

    // Comprehensive UI update
    updateCharacterLists();

    // Make sure we update the chat view too if needed
    if (state.activeChat && chatBelongsToCharacter(state.activeChat, characterId)) {
        // Reset active chat if it contained the deleted character
        state.activeChat = null;
        changeView('chat'); // Force refresh of chat view
    }

    return true;
}

function updateCharacterLists() {
    console.log("Updating character lists with", state.characters.length, "characters");
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
        console.log("DOM not ready, deferring character list update");
        document.addEventListener('DOMContentLoaded', updateCharacterLists);
        return;
    }
    try {
        // This part is for the main "Characters" view
        renderFilteredAndSortedCharacters();

        // This updates the sidebar, which has its own sorting logic
        updateSidebarCharacters();

        // If we're in an active chat with no data, reset the active chat
        if (state.activeChat && (!state.chats[state.activeChat] || state.chats[state.activeChat].length === 0)) {
            // Check if any characters in activeChat were deleted
            const chatCharIds = state.activeChat.split('-');
            const allExist = chatCharIds.every(id => state.characters.some(c => c.id === id));

            if (!allExist) {
                // Reset the active chat and update UI
                state.activeChat = null;
                state.activeCharacters = [];
                updateChatUI();
            }
        }
    } catch (error) {
        console.error("Error updating character lists:", error);
        // Try to recover by refreshing the whole page if critical error
        if (error.toString().includes("TypeError")) {
            console.log("Critical error detected, suggesting page refresh");
            showError("An error occurred. Please refresh the page.");
        }
    }
}

// --- Helper function to generate HTML for a single character item ---
// (Adapted from generateCharacterListHTML and setupCharacterItemListeners)
// One character card, built in one place.
//
// There were three copies of this markup with slightly different structures, which is why
// the layout kept going wrong in ways that were hard to pin down. The classes here are
// purpose made rather than borrowed, so the stylesheet matches what is generated instead of
// guessing at it.
//
// Two things the old markup got wrong. The name sat in a flex box with no minimum width, so
// a long name could not shrink and pushed the edit and delete controls outside the card. And
// the description was inserted without escaping, so anything in a character description was
// treated as markup.
function characterCardHTML(character) {
    const safeName = CastEscape.escapeHtml(character.name);
    const picture = CastEscape.safeImageUrl(getCharacterPicture(character));
    const id = CastEscape.escapeAttribute(character.id);

    const avatar = picture
        ? `<img src="${picture}" alt="${safeName}" loading="lazy" class="char-avatar">`
        : `<div class="char-avatar char-avatar-letter">${CastEscape.initial(character.name)}</div>`;

    const described = String(character.userContext || '').trim();
    const enhanced = String(character.enhancedContext || '').trim();

    return `
    <div class="char-card" id="character-item-${id}">
        <div class="char-card-top">
            ${avatar}
            <h3 class="char-card-name" title="${safeName}">${safeName}</h3>
            <div class="char-card-actions">
                <button id="edit-btn-${id}" class="char-icon-btn char-icon-edit" title="Edit ${safeName}" aria-label="Edit ${safeName}">
                    <i class="fas fa-pen"></i>
                </button>
                <button id="delete-btn-${id}" class="char-icon-btn char-icon-delete" title="Delete ${safeName}" aria-label="Delete ${safeName}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>

        <div class="char-card-field">
            <p class="char-card-label">Description</p>
            <div class="char-card-text">${described ? CastEscape.escapeHtml(described) : '<span class="char-card-empty">Nothing written yet</span>'}</div>
        </div>

        <div class="char-card-foot">
            <p class="char-card-badge ${enhanced ? 'is-built' : 'is-plain'}" id="enhanced-context-${id}"
               title="${enhanced ? 'A fuller profile has been written. Open Edit to read or change it.' : 'Only the short description is in use.'}">
                <i class="fas ${enhanced ? 'fa-circle-check' : 'fa-circle-minus'}"></i>
                ${enhanced
                    ? `Profile built, ${Math.round(enhanced.length / 100) / 10}k characters`
                    : 'Using the description only'}
            </p>
            <button id="enhance-btn-${id}" class="char-enhance-btn">
                <i class="fas fa-wand-magic-sparkles"></i>
                ${enhanced ? 'Rebuild profile' : 'Build profile'}
            </button>
        </div>
    </div>`;
}

function createCharacterItemHTML(character) {
    return characterCardHTML(character);
}


// --- Filtering and Sorting Logic ---
function filterCharacters(characters, searchTerm) {
    if (!searchTerm || String(searchTerm).trim() === "") {
        return characters;
    }
    const term = String(searchTerm).trim().toLowerCase();
    const list = Array.isArray(characters) ? characters : [];

    return list.filter(character => {
        if (!character) return false;

        const name = String(character.name || '').toLowerCase();
        const described = String(character.userContext || '').toLowerCase();
        const enhanced = String(character.enhancedContext || '').toLowerCase();

        if (name.includes(term) || described.includes(term) || enhanced.includes(term)) {
            return true;
        }

        // And inside the conversations, so a half remembered line is enough to find someone.
        return chatContainsText(character.id, term);
    });
}

// Does any message in any chat with this character contain this text?
//
// Cached per search term, because the filter runs on every keystroke and walking every message
// of every chat each time would make typing feel sticky. The cache is dropped whenever a
// message is added or removed.
let chatSearchCache = { term: null, matches: null };

function chatContainsText(characterId, term) {
    if (!characterId || !term) return false;

    if (chatSearchCache.term !== term) {
        chatSearchCache = { term, matches: new Set() };

        Object.keys(state.chats || {}).forEach(chatId => {
            const body = state.chats[chatId];
            if (!Array.isArray(body)) return;

            const hit = body.some(message =>
                message
                && !message.isDeleted
                && typeof message.content === 'string'
                && message.content.toLowerCase().includes(term)
            );

            if (hit) {
                getChatCharacterIds(chatId).forEach(id => chatSearchCache.matches.add(id));
            }
        });
    }

    return chatSearchCache.matches.has(characterId);
}

// Called whenever the conversations change, so a search cannot show a stale result.
function clearChatSearchCache() {
    chatSearchCache = { term: null, matches: null };
}

function sortCharacters(characters, sortOrder) {
    const sorted = [...characters]; // Create a new array to avoid mutating the original
    switch (sortOrder) {
        case "createdAt_desc":
            sorted.sort((a, b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0));
            break;
        case "createdAt_asc":
            sorted.sort((a, b) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
            break;
        case "name_asc":
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case "name_desc":
            sorted.sort((a, b) => b.name.localeCompare(a.name));
            break;
        case "lastChat_desc":
            sorted.sort((a, b) => {
                const tsA = getLastMessageTimestamp(a.id);
                const tsB = getLastMessageTimestamp(b.id);
                if (tsA === 0 && tsB !== 0) return 1; // Characters with no chats go to the end
                if (tsA !== 0 && tsB === 0) return -1; // Characters with chats come first
                return tsB - tsA; // Sort by most recent message
            });
            break;
    }
    return sorted;
}

// --- Rendering Logic for Main Character List ---
function displayCharactersInMainList(charactersToDisplay) {
    const characterListContainer = document.getElementById('character-list');

    if (!characterListContainer) {
        console.error("Character list container not found!");
        return;
    }

    // Always say when a search is hiding some of them, and offer a way out.
    showFilterNotice(
        'character-filter-notice',
        characterListContainer,
        state.characterSearchTerm,
        charactersToDisplay.length,
        (state.characters || []).length,
        clearCharacterSearch
    );

    if (charactersToDisplay.length === 0) {
        let message = "No characters created yet. Create one to get started!";
        if (state.characterSearchTerm && state.characterSearchTerm.trim() !== "") {
            message = `Nothing matches "${state.characterSearchTerm.trim()}". Clear the search to see all ${(state.characters || []).length} of them.`;
        }
        // Set the innerHTML to the "no characters" message.
        // Ensure the <p> tag has the id 'no-characters' if other parts of the code expect it,
        // though with this direct management, the id might become less critical for this specific function.
        characterListContainer.innerHTML = `<p id="no-characters" class="text-gray-500 italic">${message}</p>`;
    } else {
        // Set the innerHTML to the list of characters.
        // This implicitly removes the "no-characters" paragraph if it was there.
        characterListContainer.innerHTML = charactersToDisplay.map(character => createCharacterItemHTML(character)).join('');

        // Re-attach event listeners for the newly rendered items
        charactersToDisplay.forEach(character => {
            const editBtn = document.getElementById(`edit-btn-${character.id}`);
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    editCharacter(character.id);
                });
            }
            const deleteBtn = document.getElementById(`delete-btn-${character.id}`);
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await deleteCharacter(character.id);
                });
            }
            const enhanceBtn = document.getElementById(`enhance-btn-${character.id}`);
            if (enhanceBtn) {
                enhanceBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    enhanceCharacterContext(character.id);
                });
            }
        });
    }
}


function renderFilteredAndSortedCharacters() {
    // Only render if the characters view is active and visible
    // Also render if the initial load is happening (DOM content loaded)
    const charactersView = document.getElementById('characters-view');
    // We need to render on initial load even if characters view is hidden
    // because the initial view is often chat, but the character list
    // needs to be populated for the filter/sort controls to work correctly
    // if the user switches views later.
    let processedCharacters = [...state.characters];
    processedCharacters = filterCharacters(processedCharacters, state.characterSearchTerm);
    processedCharacters = sortCharacters(processedCharacters, state.characterSortOrder);
    displayCharactersInMainList(processedCharacters);
}

// Save app settings to local storage
function saveAppSettings(options = {}) {
    const { reinitialize = false } = options;
    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;
    setStoredItem(STORAGE_KEYS.SETTINGS, appSettings);

    if (reinitialize && isProviderConfigured()) {
        console.log("Settings changed, reinitializing provider with new configuration");
        initializeAIProvider().then(success => {
            if (success) {
                showSuccess("Provider settings updated", 2000);
            } else {
                showError("Failed to update provider settings. Please check your configuration.");
            }
        }).catch(error => {
            console.error("Error reinitializing provider:", error);
            showError(`Error updating provider: ${error.message}`);
        });
    }
}
function updateLocalBridgeStatus() {
    const status = document.getElementById('local-bridge-status');
    if (!status) return;

    const bridge = window.__GCRP_LOCAL_AI_BRIDGE__;
    status.className = 'mt-3 text-xs';

    // Only relevant when the chosen provider runs on your own machine.
    if (!isLocalProvider()) {
        status.classList.add('hidden');
        return;
    }
    status.classList.remove('hidden');

    if (bridge && bridge.active) {
        status.classList.add('text-green-600');
        status.textContent = `Bridge active in this browser (version ${bridge.version || 'unknown'}).`;
        return;
    }

    if (window.location.protocol === 'https:') {
        status.classList.add('text-amber-600');
        status.textContent = 'Bridge not found. Install the userscript to reach a model on your own machine from this page.';
        return;
    }

    status.classList.add('text-gray-500');
    status.textContent = 'Bridge not found. That is fine when the browser and the model are on the same computer. A phone needs your computer network address and the bridge.';
}

// Fills the provider menu from the registry, so adding a provider needs no HTML
// change. Free providers are grouped first because most people want those.
function populateProviderSelect() {
    const providerSelect = document.getElementById('provider-select');
    if (!providerSelect) return;

    const current = getCurrentProvider();
    providerSelect.innerHTML = '';

    const freeGroup = document.createElement('optgroup');
    freeGroup.label = 'Free to use';
    const localGroup = document.createElement('optgroup');
    localGroup.label = 'On your own machine';
    const otherGroup = document.createElement('optgroup');
    otherGroup.label = 'Anything else';

    CastProviders.listProviders().forEach(provider => {
        const option = document.createElement('option');
        option.value = provider.id;
        option.textContent = provider.label;

        if (isLocalProvider(provider.id)) {
            localGroup.appendChild(option);
        } else if (provider.free === true) {
            freeGroup.appendChild(option);
        } else {
            otherGroup.appendChild(option);
        }
    });

    [freeGroup, localGroup, otherGroup].forEach(group => {
        if (group.children.length) providerSelect.appendChild(group);
    });

    providerSelect.value = current;
}

// Shows only the fields the chosen provider actually needs, and fills them in.
function updateProviderSettingsVisibility() {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);

    const keyRow = document.getElementById('api-key-row');
    const keyInput = document.getElementById('api-key-input');
    const keyLabel = document.getElementById('api-key-label');
    const keyLink = document.getElementById('api-key-link');
    const baseUrlRow = document.getElementById('base-url-row');
    const baseUrlInput = document.getElementById('base-url-input');
    const modelInput = document.getElementById('model-input');
    const providerHelp = document.getElementById('provider-help-text');

    // The key field.
    if (keyRow) keyRow.classList.toggle('hidden', !provider.needsKey);
    if (keyInput) {
        keyInput.value = getApiKeyFor(providerId);
        keyInput.placeholder = provider.id === 'nvidia' ? 'nvapi-...' : 'Paste your key';
    }
    if (keyLabel) keyLabel.textContent = `${provider.label} API key`;
    if (keyLink) {
        if (provider.keyUrl) {
            keyLink.href = provider.keyUrl;
            keyLink.classList.remove('hidden');
            keyLink.textContent = provider.needsKey ? 'Get a key' : 'Download';
        } else {
            keyLink.classList.add('hidden');
        }
    }

    // The address field. Gemini goes through the Google library, so there is no
    // address to set.
    const needsBaseUrl = provider.kind !== CastProviders.KIND.GEMINI;
    if (baseUrlRow) baseUrlRow.classList.toggle('hidden', !needsBaseUrl);
    if (baseUrlInput) {
        baseUrlInput.value = getBaseUrlFor(providerId);
        baseUrlInput.placeholder = provider.baseUrl || 'https://example.com/v1';
    }

    // The model field is always a plain text box you can type into.
    if (modelInput) {
        modelInput.value = getModelFor(providerId);
        modelInput.placeholder = provider.defaultModel || 'Type a model name';
    }

    if (providerHelp) {
        let text = provider.freeNote || '';
        if (isLocalProvider(providerId)) text += getLocalProviderBridgeHint();
        providerHelp.textContent = text;
    }

    // The proxy only matters for providers that will not take requests from a web page, so the
    // field is only shown for those.
    const proxyRow = document.getElementById('proxy-row');
    const proxyInput = document.getElementById('proxy-url-input');
    const proxyStatus = document.getElementById('proxy-status');
    const policy = CastProviders.corsPolicy(provider);
    const relevant = !isLocalProvider(providerId) && policy !== 'direct';

    if (proxyRow) proxyRow.classList.toggle('hidden', !relevant);
    if (proxyInput) proxyInput.value = appSettings.proxyUrl || '';

    if (proxyStatus) {
        const resolved = getProxyUrl();
        if (!relevant) {
            proxyStatus.textContent = '';
        } else if (!resolved) {
            proxyStatus.textContent = 'No proxy available. Opening the file directly cannot reach this provider, so deploy the app or set an address here.';
            proxyStatus.className = 'text-xs text-amber-600 mt-1';
        } else {
            const how = policy === 'proxy'
                ? 'This provider always needs the proxy.'
                : 'Used only if the browser blocks a direct request.';
            proxyStatus.textContent = `Using ${resolved}. ${how}`;
            proxyStatus.className = 'text-xs text-gray-500 mt-1';
        }
    }

    // Show whatever suggestions we already have for this provider.
    renderModelSuggestions(providerId, state.modelSuggestions[providerId] || provider.suggestedModels.map(id => ({ id })));

    const freeOnlyRow = document.getElementById('free-only-row');
    if (freeOnlyRow) freeOnlyRow.classList.toggle('hidden', !provider.supportsFreeFilter);

    updateLocalBridgeStatus();
    updateTokenLimitWarning();
}

// Puts the suggestion list under the model field. These are hints only. Typing
// something that is not on the list is always allowed, which matters because
// every provider here changes its catalogue regularly.
function renderModelSuggestions(providerId, models) {
    const list = document.getElementById('model-suggestions');
    const count = document.getElementById('model-suggestion-count');
    if (!list) return;

    list.innerHTML = '';
    const entries = Array.isArray(models) ? models : [];

    entries.slice(0, 300).forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        if (model.free === true) option.label = `${model.id} (free)`;
        list.appendChild(option);
    });

    if (count) {
        if (!entries.length) {
            count.textContent = '';
        } else if (state.modelSuggestions[providerId]) {
            count.textContent = `${entries.length} models loaded from ${getProviderDisplayName(providerId)}. You can still type any name.`;
        } else {
            count.textContent = 'Suggestions only. Type any model name you like.';
        }
    }
}

// Asks the provider for its current catalogue.
async function loadModelSuggestions() {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);
    const button = document.getElementById('load-models-btn');
    const count = document.getElementById('model-suggestion-count');
    const freeOnly = document.getElementById('free-only-checkbox');

    if (button) {
        button.disabled = true;
        button.textContent = 'Loading...';
    }
    if (count) count.textContent = `Asking ${provider.label} what it has right now...`;

    try {
        saveVisibleProviderSettings({ reinitialize: false });

        const models = await fetchModelSuggestions(providerId, {
            freeOnly: Boolean(freeOnly && freeOnly.checked),
        });

        state.modelSuggestions[providerId] = models;
        renderModelSuggestions(providerId, models);

        // The list only appears when the field is focused, so say plainly that it
        // worked and how to see it.
        if (count) {
            const freeCount = models.filter(model => model.free === true).length;
            const freeNote = provider.supportsFreeFilter && freeCount
                ? ` ${freeCount} of them are free.`
                : '';
            count.textContent = `Loaded ${models.length} models from ${provider.label}.${freeNote} Tap the model box to see them, or keep typing your own.`;
        }
    } catch (error) {
        if (count) count.textContent = error.message;
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = 'Load available models';
        }
    }
}

// Warns when the response limit is low enough to squeeze out the reply.
function updateTokenLimitWarning() {
    const warningElement = document.getElementById('token-limit-warning');
    if (!warningElement) return;

    const warning = CastProviders.tokenLimitWarning(
        appSettings.conversationTokens,
        getCurrentProvider(),
        getModelFor()
    );

    if (warning) {
        warningElement.textContent = warning;
        warningElement.classList.remove('hidden');
    } else {
        warningElement.classList.add('hidden');
    }
}

function markProviderConnectionDirty() {
    state.isApiConnected = false;
    state.activeProvider = null;
    checkApiKey();
}

// Reads the visible fields into settings. One set of fields covers every
// provider now, rather than a separate panel for each one.
function saveVisibleProviderSettings(options) {
    const providerSelect = document.getElementById('provider-select');
    const keyInput = document.getElementById('api-key-input');
    const baseUrlInput = document.getElementById('base-url-input');
    const modelInput = document.getElementById('model-input');

    if (providerSelect && providerSelect.value) {
        appSettings.provider = CastProviders.getProvider(providerSelect.value).id;
    }

    const providerId = getCurrentProvider();

    if (!appSettings.apiKeys) appSettings.apiKeys = {};
    if (!appSettings.models) appSettings.models = {};
    if (!appSettings.baseUrls) appSettings.baseUrls = {};

    if (keyInput && !keyInput.classList.contains('hidden')) {
        setApiKeyFor(providerId, keyInput.value.trim());
    }
    const baseUrlRow = document.getElementById('base-url-row');
    const baseUrlVisible = baseUrlRow && !baseUrlRow.classList.contains('hidden');
    if (baseUrlInput && baseUrlVisible) {
        // Only read this when the field is on screen. Gemini keeps its address
        // internally and does not show the field, so reading it here would write
        // a value the reader never chose.
        appSettings.baseUrls[providerId] = baseUrlInput.value.trim();
    }
    if (modelInput) {
        // Stored exactly as typed. Nothing here second guesses the name.
        appSettings.models[providerId] = modelInput.value.trim();
    }

    const proxyInput = document.getElementById('proxy-url-input');
    if (proxyInput) {
        appSettings.proxyUrl = proxyInput.value.trim();
    }

    delete appSettings.allowGroupChats;
    delete appSettings.topK;
    delete appSettings.topP;

    saveAppSettings(options || { reinitialize: false });
}

// Initialize event listeners for model settings
function initializeModelSettings() {
    populateProviderSelect();

    const providerSelect = document.getElementById('provider-select');
    const keyInput = document.getElementById('api-key-input');
    const baseUrlInput = document.getElementById('base-url-input');
    const modelInput = document.getElementById('model-input');
    const loadModelsBtn = document.getElementById('load-models-btn');
    const temperatureRange = document.getElementById('temperature-range');
    const temperatureValue = document.getElementById('temperature-value');
    const enhancedContextTokens = document.getElementById('enhanced-context-tokens');
    const conversationTokens = document.getElementById('conversation-tokens');
    const testModelBtn = document.getElementById('test-model-btn');
    const includeKeyCheckbox = document.getElementById('include-key-in-backups');

    if (temperatureRange && temperatureValue) {
        temperatureRange.value = appSettings.temperature;
        temperatureValue.textContent = appSettings.temperature;
    }

    if (enhancedContextTokens) {
        enhancedContextTokens.value = getTokenLimit(appSettings.enhancedContextTokens, 4096);
    }

    if (conversationTokens) {
        conversationTokens.value = getConversationTokenLimit();
    }

    if (includeKeyCheckbox) {
        includeKeyCheckbox.checked = Boolean(appSettings.includeKeyInBackups);
    }

    updateProviderSettingsVisibility();
    window.addEventListener('gcrp-local-ai-bridge-ready', updateProviderSettingsVisibility, { once: true });

    if (providerSelect) {
        providerSelect.addEventListener('change', () => {
            // Switching provider must not carry the previous provider's key or
            // model across, so read the fields before the provider changes and
            // then refresh them for the new one.
            appSettings.provider = CastProviders.getProvider(providerSelect.value).id;
            recordActivityIfReady(CastLog.KINDS.SETTINGS_CHANGED, `provider set to ${getProviderDisplayName()}`);
            saveAppSettings({ reinitialize: false });
            markProviderConnectionDirty();
            updateProviderSettingsVisibility();
        });
    }

    [keyInput, baseUrlInput, modelInput, document.getElementById('proxy-url-input')].forEach(input => {
        if (!input) return;
        input.addEventListener('change', () => {
            saveVisibleProviderSettings();
            markProviderConnectionDirty();
        });
    });

    if (loadModelsBtn) {
        loadModelsBtn.addEventListener('click', loadModelSuggestions);
    }

    const testProxyBtn = document.getElementById('test-proxy-btn');
    if (testProxyBtn) {
        testProxyBtn.addEventListener('click', testProxy);
    }

    if (temperatureRange && temperatureValue) {
        temperatureRange.addEventListener('input', (e) => {
            appSettings.temperature = parseFloat(e.target.value);
            temperatureValue.textContent = e.target.value;
            saveAppSettings({ reinitialize: false });
        });
    }

    if (enhancedContextTokens) {
        enhancedContextTokens.addEventListener('change', (e) => {
            e.target.value = getTokenLimit(e.target.value, 4096);
            appSettings.enhancedContextTokens = parseInt(e.target.value, 10);
            saveAppSettings({ reinitialize: false });
        });
    }

    if (conversationTokens) {
        conversationTokens.addEventListener('change', (e) => {
            e.target.value = getTokenLimit(e.target.value, 4096);
            appSettings.conversationTokens = parseInt(e.target.value, 10);
            appSettings.maxTokens = appSettings.conversationTokens;
            saveAppSettings({ reinitialize: false });
            updateTokenLimitWarning();
        });
    }

    if (includeKeyCheckbox) {
        includeKeyCheckbox.addEventListener('change', (e) => {
            appSettings.includeKeyInBackups = e.target.checked;
            saveAppSettings({ reinitialize: false });
        });
    }

    if (testModelBtn) {
        testModelBtn.addEventListener('click', testModelConfiguration);
    }

    const refreshStorageBtn = document.getElementById('refresh-storage-btn');
    if (refreshStorageBtn) {
        refreshStorageBtn.addEventListener('click', updateStoragePanel);
    }

    const memoryToggle = document.getElementById('memory-compaction-toggle');
    if (memoryToggle) {
        memoryToggle.checked = Boolean(appSettings.memoryCompaction);
        memoryToggle.addEventListener('change', (e) => {
            appSettings.memoryCompaction = e.target.checked;
            saveAppSettings({ reinitialize: false });
            updateMemoryPanel();

            if (e.target.checked) {
                showSuccess("Long chats will be summarised from now on. Your messages are kept as they are.", 5000);
            } else {
                showSuccess("Turned off. Full conversations are sent again from the next reply.", 4000);
            }
        });
    }

    setupActivityLogToggle();
    updateMemoryPanel();
    updateStoragePanel();

    // Filled from the brand module, so the version shown is never one that was
    // typed into the page and then forgotten.
    const settingsVersion = document.getElementById('settings-version');
    if (settingsVersion) {
        settingsVersion.textContent = `${CastBrand.name} ${CastBrand.appVersion}`;
    }

    const aboutVersion = document.getElementById('about-version');
    if (aboutVersion) {
        const count = CastProviders.listProviders().length;
        aboutVersion.textContent = `${CastBrand.name} ${CastBrand.appVersion}, with ${count} providers to choose from.`;
    }
}

// Draws the activity log. Newest first, one line each, timestamped to the second so it
// can be lined up with when you remember doing something.
function renderActivityLog() {
    const panel = document.getElementById('activity-log');
    const entries = CastLog.newestFirst(state.activityLog);

    // The summary shows even when the log itself is collapsed.
    const summary = document.getElementById('activity-log-summary');
    if (summary) {
        const failures = entries.filter(entry => /fail/i.test(entry.kind)).length;
        summary.textContent = failures
            ? `${entries.length} entries, ${failures} ${failures === 1 ? 'failure' : 'failures'}`
            : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
        summary.className = failures ? 'text-xs text-red-600 font-medium' : 'text-xs text-gray-500';
    }

    if (!panel || panel.classList.contains('hidden')) return;

    if (!entries.length) {
        panel.innerHTML = '<p class="text-gray-500">Nothing recorded yet.</p>';
        return;
    }

    const lastBackupAt = state.backupState ? state.backupState.lastBackupAt : null;

    const shown = showOnlyFailures ? CastLog.failuresOnly(state.activityLog) : entries;

    if (!shown.length) {
        panel.innerHTML = showOnlyFailures
            ? '<p class="text-gray-500">No failures recorded. That is the good outcome.</p>'
            : '<p class="text-gray-500">Nothing recorded yet.</p>';
        return;
    }

    panel.innerHTML = shown.map(entry => {
        const level = entry.level || CastLog.levelOf(entry.kind);
        const isSinceBackup = lastBackupAt && String(entry.at) > String(lastBackupAt);

        const detail = entry.detail
            ? ` <span class="log-detail">${CastEscape.escapeHtml(entry.detail)}</span>`
            : '';

        return `<div class="log-line log-${level}${isSinceBackup ? ' log-recent' : ''}">`
            + `<span class="log-time">${CastEscape.escapeHtml(CastLog.formatTime(entry.at))}</span>`
            + `<span class="log-kind">${CastEscape.escapeHtml(entry.kind)}</span>`
            + detail
            + `</div>`;
    }).join('');
}

// Whether the log is filtered to failures.
let showOnlyFailures = false;

function setupActivityLogToggle() {
    const failuresBtn = document.getElementById('activity-log-failures');
    if (failuresBtn) {
        failuresBtn.addEventListener('click', () => {
            showOnlyFailures = !showOnlyFailures;
            failuresBtn.textContent = showOnlyFailures ? 'Show everything' : 'Failures only';
            failuresBtn.className = showOnlyFailures
                ? 'text-xs text-primary font-semibold underline'
                : 'text-xs text-gray-600 hover:text-primary underline';
            renderActivityLog();
        });
    }

    // Copying the whole log matters because the useful thing to do with a log is give it to
    // somebody who can read it.
    const copyBtn = document.getElementById('activity-log-copy');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const header = [
                `${CastBrand.name} ${CastBrand.appVersion}`,
                `Provider: ${getProviderDisplayName()}, model ${getModelFor()}`,
                `Page: ${window.location.origin || 'opened from a file'}`,
                `Proxy: ${getProxyUrl() || 'none'}`,
                '',
            ].join('\n');

            const text = header + CastLog.asText(state.activityLog);

            try {
                await navigator.clipboard.writeText(text);
                notify('Log copied, including which provider and version you are on.', 'success');
            } catch (error) {
                // Clipboard access can be refused, so fall back to selecting it for copying by hand.
                const panel = document.getElementById('activity-log');
                if (panel) {
                    const range = document.createRange();
                    range.selectNodeContents(panel);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                    notify('Could not reach the clipboard, so the log has been selected for you to copy.', 'warning');
                } else {
                    notify(`Could not copy: ${error.message}`, 'error');
                }
            }
        });
    }

    const button = document.getElementById('activity-log-toggle');
    const panel = document.getElementById('activity-log');
    const chevron = document.getElementById('activity-log-chevron');
    const label = document.getElementById('activity-log-label');
    if (!button || !panel) return;

    button.addEventListener('click', () => {
        const nowOpen = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !nowOpen);
        if (chevron) chevron.className = `fas fa-chevron-${nowOpen ? 'down' : 'right'} text-xs`;
        if (label) label.textContent = nowOpen ? 'Hide' : 'Show';
        if (nowOpen) renderActivityLog();
    });

    // Open to begin with. It used to be behind a small link inside another card, which made
    // the first place to look when something goes wrong the hardest thing to find.
    renderActivityLog();

    // The longer explanation under the summarising setting, kept out of the way until
    // asked for, because that block had grown into an essay.
    const moreLink = document.getElementById('memory-more-link');
    const more = document.getElementById('memory-more');
    if (moreLink && more) {
        moreLink.addEventListener('click', (e) => {
            e.preventDefault();
            const nowOpen = more.classList.contains('hidden');
            more.classList.toggle('hidden', !nowOpen);
            moreLink.textContent = nowOpen ? 'Hide this' : 'Why this happens';
        });
    }
}

// Says plainly what state the current chat's memory is in, so this never feels
// like something happening behind the reader's back.
function updateMemoryPanel() {
    const panel = document.getElementById('memory-panel');
    if (!panel) return;

    if (!appSettings.memoryCompaction) {
        panel.textContent = "Currently off. Every message sends the whole conversation.";
        return;
    }

    if (!state.activeChat || !Array.isArray(state.chats[state.activeChat])) {
        panel.textContent = "On. Open a chat to see what it is doing there.";
        return;
    }

    const described = CastMemory.describeMemoryState(
        getChatMemory(state.activeChat),
        state.chats[state.activeChat]
    );

    const memory = getChatMemory(state.activeChat);
    let extra = "";
    if (memory.consecutiveFailures >= 3) {
        extra = " Summarising failed a few times here, so it has stopped trying and is sending everything instead.";
    } else if (!described.compacted) {
        extra = " This chat is not long enough to be worth summarising yet.";
    }

    panel.textContent = `${described.text}${extra}`;
}

// Shows how much room the app is using. Worth having in plain sight, because
// running out of room used to make saves fail silently.
async function updateStoragePanel() {
    const panel = document.getElementById('storage-panel');
    if (!panel) return;

    const usage = castStore.usage();
    // Browsers do not publish the real limit. Five megabytes is the usual figure
    // and is only used here to give the bar something to fill.
    const assumedLimit = 5 * 1024 * 1024;
    const textBytes = usage.characters;
    const percent = Math.min(100, Math.round((textBytes / assumedLimit) * 100));

    let pictureLine = 'Pictures: checking...';
    try {
        const pictures = await CastImages.measureStore();
        pictureLine = `Pictures: ${formatBytes(pictures.bytes)} across ${pictures.count} ${pictures.count === 1 ? 'character' : 'characters'}, stored separately so they cannot crowd out your chats.`;
    } catch (error) {
        pictureLine = 'Pictures: stored separately from your chats.';
    }

    const barColour = percent > 85 ? 'bg-red-500' : percent > 60 ? 'bg-amber-500' : 'bg-green-500';

    panel.innerHTML = `
        <p class="text-sm text-gray-700 mb-2">Characters, chats and settings: ${CastEscape.escapeHtml(formatBytes(textBytes))} of roughly ${CastEscape.escapeHtml(formatBytes(assumedLimit))}</p>
        <div class="w-full bg-gray-200 rounded-full h-2 mb-2">
            <div class="${barColour} h-2 rounded-full" style="width: ${percent}%"></div>
        </div>
        <p class="text-xs text-gray-500">${CastEscape.escapeHtml(pictureLine)}</p>
    `;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} bytes`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

// Test model configuration
async function testModelConfiguration() {
    const testResult = document.getElementById('test-result');
    const testStatus = document.getElementById('test-status');
    const testDetails = document.getElementById('test-details');
    const testBtn = document.getElementById('test-model-btn');
    const testIcon = document.getElementById('test-icon');

    if (!testResult || !testStatus || !testDetails || !testBtn) return;

    // The icon has three states. It used to be left spinning even after the check
    // finished, which read as though it were still going.
    const setIcon = (classes) => {
        if (testIcon) testIcon.className = classes;
    };

    testResult.classList.remove('hidden', 'bg-green-100', 'bg-red-100');
    testResult.classList.add('bg-blue-100');
    setIcon('fas fa-spinner fa-spin mt-1 text-blue-600');
    testStatus.textContent = 'Checking...';
    testDetails.textContent = `Connecting to ${getProviderDisplayName()}.`;
    testBtn.disabled = true;

    try {
        saveVisibleProviderSettings({ reinitialize: false });

        if (!isProviderConfigured()) {
            throw new Error(getProviderConfigurationMessage());
        }

        const connected = await initializeAIProvider();
        if (!connected) {
            throw new Error(`Could not connect to ${getProviderDisplayName()}.`);
        }

        testDetails.textContent = 'Connected. Asking for a short reply.';
        const response = await callAIText("Reply with exactly: working", 256);

        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-green-100');
        setIcon('fas fa-circle-check mt-1 text-green-600');
        testStatus.textContent = 'Working';
        testDetails.innerHTML = `
            <div class="space-y-1">
                <p>Provider: ${CastEscape.escapeHtml(getProviderDisplayName())}</p>
                <p>Model: ${CastEscape.escapeHtml(getModelFor())}</p>
                <p>Creativity: ${CastEscape.escapeHtml(String(appSettings.temperature))}</p>
                <p>Response limit: ${CastEscape.escapeHtml(String(getConversationTokenLimit()))} tokens</p>
                <p>It said: ${CastEscape.escapeHtml(response.substring(0, 120))}</p>
            </div>
        `;
    } catch (error) {
        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-red-100');
        setIcon('fas fa-circle-xmark mt-1 text-red-600');
        testStatus.textContent = 'Not working yet';
        testDetails.textContent = error.message;
        console.error('Provider test failed:', error);
    } finally {
        testBtn.disabled = false;
    }
}
// Initialize message delete buttons based on screen size
function initMessageDeleteButtons() {
    // Check if we're on mobile or desktop
    const isMobile = window.innerWidth <= 768;

    // Get all delete buttons
    const deleteButtons = document.querySelectorAll('button[id^="delete-msg-"]');

    // Set initial visibility based on screen size
    deleteButtons.forEach(button => {
        if (isMobile) {
            button.classList.remove('hidden');
        } else {
            button.classList.add('hidden');
        }
    });
}

// Utility function to debounce frequent events like resize
function debounce(func, wait) {
    let timeout;
    return function () {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(context, args);
        }, wait);
    };
}

// Save personal context
function savePersonalContext() {
    const nameInput = document.getElementById('user-name');
    const personalityInput = document.getElementById('user-personality');
    const contextInput = document.getElementById('user-context');

    // Update state with new values
    state.personalContext = {
        name: nameInput.value.trim(),
        personality: personalityInput.value.trim(),
        context: contextInput.value.trim()
    };

    // Save to storage
    setStoredItem(STORAGE_KEYS.PERSONAL_CONTEXT, state.personalContext);

    // If there's an active chat, update the chat UI to reflect changes
    if (state.activeChat && state.chats[state.activeChat]) {
        // Save current chat to history to preserve context
        saveCurrentChatToHistory();

        // Show success message
        showSuccess("Personal context updated! Changes will be reflected in your next interactions.", 3000);
    } else {
        showSuccess("Personal context saved successfully!", 3000);
    }
}

// Helper function to get last message timestamp for a chat
function getLastMessageTimestamp(characterId) {
    // Find all chats with this character
    const chatsWithCharacter = Object.keys(state.chats).filter(chatId => chatBelongsToCharacter(chatId, characterId));

    if (chatsWithCharacter.length === 0) return 0;

    // Track the latest timestamp found
    let latestTimestamp = 0;

    // Find the most recent message in any chat with this character
    chatsWithCharacter.forEach(chatId => {
        const messages = state.chats[chatId] || [];
        if (messages.length === 0) {
            // Check if this is the active chat - if so, use current time
            if (state.activeChat === chatId) {
                const currentTime = Date.now();
                if (currentTime > latestTimestamp) {
                    latestTimestamp = currentTime;
                }
            }
            return;
        }

        const lastMessage = messages
            .filter(msg => !msg.isDeleted)
            .reverse()
            .find(msg => true); // Get first non-deleted message

        if (lastMessage) {
            const msgTimestamp = new Date(lastMessage.timestamp).getTime();
            if (msgTimestamp > latestTimestamp) {
                latestTimestamp = msgTimestamp;
            }
        }
    });

    // The order used to be forced to the top for whoever was selected, by reporting
    // the current time as their last message. That is why opening a character made it
    // jump to the top of the list before anything had been said. The list should
    // reflect when you last actually talked to someone, so it returns the real
    // timestamp and nothing else.
    return latestTimestamp;
}

// Function to regenerate the last AI message
async function regenerateMessage(characterId) {
    if (state.isResponseInProgress) {
        showError("Please wait for the current response to finish before regenerating.");
        return;
    }

    if (!state.activeChat || state.activeCharacters.length === 0) {
        showError("No active chat or characters selected");
        return;
    }
    // Get the messages in the current chat
    const messages = state.chats[state.activeChat] || [];
    if (messages.length === 0) return;

    // Find the last message from the specified character
    const characterMessages = messages
        .filter(m => !m.isUser && m.characterId === characterId && !m.isDeleted && !m.isTyping)
        .reverse();

    if (characterMessages.length === 0) return;

    // Get the last message from this character
    const lastMessage = characterMessages[0];

    // Delete the last message
    lastMessage.isDeleted = true;
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);

    // Update UI
    updateChatMessages();

    // Find the character object
    const character = state.characters.find(c => c.id === characterId);
    if (!character) return;

    // Find the message before this one to determine the user message that triggered it
    const messageIndex = messages.findIndex(m => m.id === lastMessage.id);

    // Find the last user message that was sent before this AI message, including continue messages
    let lastUserMsg = null;
    for (let i = messageIndex - 1; i >= 0; i--) {
        if (messages[i].isUser && !messages[i].isDeleted) {
            lastUserMsg = messages[i];
            break;
        }
    }

    // If no user message was found, create a special "regenerate" message
    if (!lastUserMsg) {
        lastUserMsg = {
            id: generateUniqueId(),
            content: "", // Empty content for regeneration
            isUser: true,
            timestamp: new Date().toISOString(),
            isDeleted: true, // Hidden from the UI
            isContinue: true // Treat like a continue message for regeneration
        };
    }

    // Generate a new response
    state.isResponseInProgress = true;
    updateSendButtonState();
    updateChatMessages();

    try {
        await getCharacterResponse(character, lastUserMsg);
    } finally {
        state.isResponseInProgress = false;
        updateSendButtonState();
        updateChatMessages();
    }
}

// After the dismissError function
function editCharacter(characterId) {
    console.log("Editing character:", characterId);

    // Start clean. Without this, opening one character, picking a picture, closing
    // without saving, then opening a different character would carry the first
    // picture across to the second.
    state.pendingEditProfilePicture = null;

    // Find character in state
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("That character could not be found.");
        return;
    }

    // The enhanced profile, so you can read it and change it rather than only rebuilding it.
    const enhancedInput = document.getElementById('edit-enhanced-context');
    const enhancedMeta = document.getElementById('edit-enhanced-meta');
    if (enhancedInput) {
        const enhanced = String(character.enhancedContext || '');
        enhancedInput.value = enhanced;
        if (enhancedMeta) {
            enhancedMeta.textContent = enhanced
                ? `${enhanced.length.toLocaleString()} characters, in use`
                : 'Not built yet';
        }
    }

    // Populate the edit form
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    nameInput.value = character.name;
    contextInput.value = character.userContext;
    idInput.value = character.id;

    // Set profile picture if available
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const removeButton = document.getElementById('edit-remove-profile-picture');

    if (profilePicturePreview) {
        const editPicture = getCharacterPicture(character);
        if (editPicture) {
            // Built as a node so the name never needs escaping.
            profilePicturePreview.innerHTML = '';
            const img = document.createElement('img');
            img.src = editPicture;
            img.alt = character.name;
            img.className = 'w-full h-full object-cover';
            profilePicturePreview.appendChild(img);
            profilePicturePreview.classList.add('has-image');

            // Show the remove button
            if (removeButton) {
                removeButton.classList.remove('hidden');
            }
        } else {
            // Display the default icon
            profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
            profilePicturePreview.classList.remove('has-image');

            // Hide the remove button
            if (removeButton) {
                removeButton.classList.add('hidden');
            }
        }
    }

    // Show the edit modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function saveEditedCharacter() {
    // Get input fields
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();
    const id = idInput.value;

    // Validate inputs
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // The upload handler leaves the shrunk picture here. Fall back to reading the
    // preview for the case where the picture was not changed this time round.
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    let profilePicture = state.pendingEditProfilePicture || null;

    if (!profilePicture && profilePicturePreview && profilePicturePreview.querySelector('img')) {
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Find character in state and update it
    const characterIndex = state.characters.findIndex(c => c.id === id);
    if (characterIndex === -1) {
        showError("That character could not be found.");
        return;
    }

    // Store old name for success message
    const oldName = state.characters[characterIndex].name;
    const oldEnhancedContext = state.characters[characterIndex].enhancedContext; // Store old enhanced context

    // Update character and REMOVE the enhanced context since we've changed the user context
    state.characters[characterIndex].name = name;
    state.characters[characterIndex].userContext = context;
    // The enhanced profile is whatever is in the box.
    //
    // Editing a character used to discard it outright, on the grounds that the description had
    // changed. That meant any hand written wording was lost the moment you corrected a typo in
    // a name. It is editable now, so it is saved like any other field.
    const editedEnhanced = document.getElementById('edit-enhanced-context');
    const enhancedValue = editedEnhanced ? String(editedEnhanced.value).trim() : '';
    state.characters[characterIndex].enhancedContext = enhancedValue || null;
    state.characters[characterIndex].hasPicture = Boolean(profilePicture);
    recordActivity(CastLog.KINDS.CHARACTER_EDITED, name);

    // Any picture still sitting on the record from an older version is dropped,
    // because the picture now lives in its own store.
    delete state.characters[characterIndex].profilePicture;

    if (profilePicture) {
        CastImages.putPicture(id, profilePicture)
            .then(() => { state.pictureCache[id] = profilePicture; })
            .catch(error => {
                console.warn("That picture could not be saved:", error);
                showError("The changes were saved but the picture could not be. Try a different image.");
            });
    } else {
        // The picture was removed, so take it out of the store as well rather
        // than leaving it behind taking up room.
        CastImages.deletePicture(id).catch(() => {});
        delete state.pictureCache[id];
    }
    state.pendingEditProfilePicture = null;

    // IMPORTANT: Update the character in the activeCharacters array as well
    // This ensures the chat immediately uses the new context
    if (state.activeCharacters) {
        const activeCharIndex = state.activeCharacters.findIndex(c => c.id === id);
        if (activeCharIndex !== -1) {
            // Update the active character with the new data
            // The live record itself, not a copy of it. Spreading it into a new
            // object here used to break the link, so later changes such as an
            // enhanced profile never reached the chat.
            state.activeCharacters[activeCharIndex] = state.characters[characterIndex];
            console.log("Updated active character with new context");
        }
    }

    // If name changed and character is in selected characters, update the chat title
    if (oldName !== name && state.selectedCharacters.includes(id)) {
        updateChatUI();
    }

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Update the specific character element directly for immediate feedback
    const charElement = document.getElementById(`character-item-${id}`);
    if (charElement) {
        // Determine how to display the character avatar
        const editedSafeName = CastEscape.escapeHtml(name);
        const editedPicture = CastEscape.safeImageUrl(profilePicture);
        let avatarHTML = '';
        if (editedPicture) {
            avatarHTML = `<img src="${editedPicture}" alt="${editedSafeName}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${CastEscape.initial(name)}</div>`;
        }

        // Find and update the character header with name and avatar
        const headerElement = charElement.querySelector('.flex.justify-between.items-start');
        if (headerElement) {
            const nameWithAvatarHTML = `
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${name}</h3>
                </div>
            `;

            // Replace the first child (which should be either the name or the flex container with avatar and name)
            const firstChild = headerElement.firstElementChild;
            if (firstChild) {
                // Create a temporary container
                const temp = document.createElement('div');
                temp.innerHTML = nameWithAvatarHTML.trim();

                // Replace the first child with our new element
                headerElement.replaceChild(temp.firstElementChild, firstChild);
            }
        }

        // Find and update the user context
        const contextElement = charElement.querySelector('.text-gray-600.text-sm.mt-1.max-h-32');
        if (contextElement) {
            contextElement.textContent = context;
        }

        // Remove enhanced context if it exists
        const enhancedContextElement = charElement.querySelector(`#enhanced-context-${id}`);
        if (enhancedContextElement) {
            enhancedContextElement.remove();
        }

        // Update enhance button text (since enhanced context was removed)
        const enhanceBtn = charElement.querySelector(`#enhance-btn-${id}`);
        if (enhanceBtn) {
            enhanceBtn.innerHTML = '<i class="fas fa-magic mr-1"></i> Enhance Context';
        }
    }

    // Update sidebar character for immediate feedback
    const sidebarCharElement = document.getElementById(`sidebar-char-${id}`);
    if (sidebarCharElement) {
        // Update the name
        const sidebarNameElement = sidebarCharElement.querySelector('.text-sm.font-medium');
        if (sidebarNameElement) {
            sidebarNameElement.textContent = name;
        }

        // Update the avatar
        const avatarElement = sidebarCharElement.querySelector('.character-avatar');
        if (avatarElement) {
            if (profilePicture) {
                avatarElement.innerHTML = '';
                const sidebarImg = document.createElement('img');
                sidebarImg.src = profilePicture;
                sidebarImg.alt = name;
                sidebarImg.className = 'w-full h-full object-cover';
                avatarElement.appendChild(sidebarImg);
                avatarElement.classList.add('has-image');
            } else {
                avatarElement.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
                avatarElement.classList.remove('has-image');
            }
        }
    }

    // Update UI
    updateSidebarCharacters();
    renderFilteredAndSortedCharacters(); // Re-render the main list if filters/sorts are active

    // Close the modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.add('hidden');
    }

    // Notify in active chat if the character is part of it
    if (state.activeChat && state.activeChat.includes(id)) {
        let notificationContent = `System: ${name}'s context has been updated.`;
        if (oldEnhancedContext) {
            notificationContent += " The character's enhanced context was cleared and may need to be re-generated from the new base context.";
        }
        notificationContent += " The new details will apply to future messages in this chat.";

        const systemMessage = {
            id: generateUniqueId(),
            content: notificationContent,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };
        addMessage(systemMessage);
    }

    // Show success message
    showSuccess(`Character "${oldName}" updated to "${name}" successfully!`);
}

function setupEditCharacterModal() {
    // Set up close button
    const closeButton = document.getElementById('close-edit-modal');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const modal = document.getElementById('edit-character-modal');
            if (modal) {
                modal.classList.add('hidden');
            }
        });
    }

    // Set up save button
    const saveButton = document.getElementById('save-character-btn');
    if (saveButton) {
        saveButton.addEventListener('click', saveEditedCharacter);
    }

    // Close modal when clicking outside
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.classList.add('hidden');
            }
        });
    }
}

// Export app data to a JSON file
// Saves a backup file.
//
// Pictures need care here. They are not stored on the character records any more,
// they live in their own store, so this has to go and fetch them and put them
// back onto the records for the file. Without that step a backup looks complete
// and quietly contains no pictures at all, which is exactly what happened in
// version 2.0.0.
//
// The file format deliberately embeds pictures the same way every older version
// did. That means one import path handles files of any age, and a backup written
// today can still be opened by an older copy of the app.
async function exportAppData() {
    const exportButton = document.getElementById('export-data-btn');
    const originalLabel = exportButton ? exportButton.innerHTML : '';

    try {
        if (exportButton) {
            exportButton.disabled = true;
            exportButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Preparing...';
        }

        // Fetch the pictures and put them back on the character records for the
        // file. state.characters is not modified, only the copy being saved.
        let pictures = {};
        let pictureProblem = "";
        try {
            pictures = await CastImages.getAllPictures();
        } catch (error) {
            console.error("Pictures could not be read for the backup:", error);
            pictureProblem = " Pictures could not be read, so this file does not contain them.";
        }

        const charactersForFile = (state.characters || []).map(character => {
            if (!character || typeof character !== 'object') return character;
            const copy = Object.assign({}, character);
            const picture = pictures[character.id]
                || (typeof character.profilePicture === 'string' ? character.profilePicture : '');
            if (picture) {
                copy.profilePicture = picture;
                copy.hasPicture = true;
            } else {
                delete copy.profilePicture;
                // Do not claim a picture the file does not carry.
                if (copy.hasPicture) delete copy.hasPicture;
            }
            return copy;
        });

        // Check the file really does carry what it claims before writing it.
        const expected = (state.characters || []).filter(c => c && (c.hasPicture || c.profilePicture)).length;
        const included = charactersForFile.filter(c => c && c.profilePicture).length;
        if (expected > included && !pictureProblem) {
            pictureProblem = ` ${expected - included} of ${expected} pictures could not be found, so they are not in this file.`;
        }

        const data = {
            characters: charactersForFile,
            chats: state.chats,
            chatHistory: state.chatHistory,
            lastActiveChats: state.lastActiveChats,
            chatMembers: state.chatMembers,
            settings: appSettings,
            personalContext: state.personalContext,
            apiKeys: appSettings.apiKeys || {},
        };

        const includeKey = Boolean(appSettings.includeKeyInBackups);
        const payload = CastBackup.buildExport({
            data,
            brand: CastBrand,
            includeApiKey: includeKey,
        });

        const counts = CastBackup.summarise(data);
        const filename = CastBackup.buildFilename({
            slug: CastBrand.fileSlug,
            when: new Date(),
            characterCount: counts.characterCount,
            chatCount: counts.chatCount,
            messageCount: counts.messageCount,
        });

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;

        document.body.appendChild(link);
        link.click();

        setTimeout(() => {
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 100);

        // Reset the reminder, since there is now a fresh backup.
        state.backupState = CastBackup.recordBackupTaken(state.backupState);
        castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
        recordActivity(CastLog.KINDS.BACKUP_SAVED, filename);
        hideBackupReminder();
        updateLastBackupStatus();

        const keyNote = includeKey ? ' It contains your API keys, so keep it private.' : '';
        const pictureNote = included ? ` Includes ${included} ${included === 1 ? 'picture' : 'pictures'}.` : '';

        if (pictureProblem) {
            showError(`Saved ${filename}, but${pictureProblem}`);
        } else {
            showSuccess(`Saved ${filename}.${pictureNote}${keyNote}`, 6000);
        }
    } catch (error) {
        console.error("Could not save a backup:", error);
        showError(`The backup could not be saved: ${error.message}`);
    } finally {
        if (exportButton) {
            exportButton.disabled = false;
            exportButton.innerHTML = originalLabel;
        }
    }
}

// Loads a backup file.
//
// The old version wrote each key straight over your data with no checking and no
// way back. If one write failed partway through, for example because there was
// no room left, you were left holding characters from the new file and chats from
// the old one, which is the mismatched state that used to trigger the history
// deletion on the next reload.
//
// Now the file is checked first, a snapshot of your current data is taken before
// anything is touched, and if any part of the write fails the snapshot is put
// back.
function importAppData() {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';

    fileInput.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;

        const reader = new FileReader();

        reader.onload = async (loadEvent) => {
            try {
                let raw;
                try {
                    raw = JSON.parse(loadEvent.target.result);
                } catch (parseError) {
                    throw new Error("That file is not valid JSON, so it cannot be read.");
                }

                // Check the file before touching anything.
                const checked = CastBackup.normaliseImport(raw);
                if (!checked.ok) {
                    throw new Error(checked.problems.join(' '));
                }

                const incoming = checked.summary;
                const current = CastBackup.summarise({
                    characters: state.characters,
                    chats: state.chats,
                });

                const confirmMessage = [
                    `This file holds ${incoming.characterCount} characters, ${incoming.chatCount} chats and ${incoming.messageCount} messages.`,
                    ``,
                    `It will replace what is here now, which is ${current.characterCount} characters, ${current.chatCount} chats and ${current.messageCount} messages.`,
                    ``,
                    `Continue?`,
                ].join('\n');

                if (!confirm(confirmMessage)) return;

                // Take a snapshot so there is something to go back to.
                const snapshotSaved = CastStorage.saveSnapshot(castStore, {
                    characters: state.characters,
                    chats: state.chats,
                    chatHistory: state.chatHistory,
                    lastActiveChats: state.lastActiveChats,
                    chatMembers: state.chatMembers,
                });

                if (!snapshotSaved.ok) {
                    const proceed = confirm(
                        "There was not enough room to save a copy of your current data first, so this cannot be undone if it goes wrong. Continue anyway?"
                    );
                    if (!proceed) return;
                }

                const imported = checked.data;

                // Move any pictures embedded in the file out of the way before
                // writing, so they cannot fill up the space the chats need.
                let pictureNote = '';
                try {
                    const migration = await CastImages.migrateEmbeddedPictures(imported.characters);
                    imported.characters = migration.characters;
                    if (migration.moved) {
                        const saved = migration.bytesBefore - migration.bytesAfter;
                        pictureNote = ` ${migration.moved} pictures were moved out of the crowded storage area`;
                        pictureNote += saved > 0 ? ` and shrunk, saving ${formatBytes(saved)}.` : '.';
                    }
                } catch (pictureError) {
                    console.warn("Pictures could not be moved, leaving them where they are:", pictureError);
                }

                // Repair the history grouping if the file came from a version that
                // filed it under a key with a timestamp glued on.
                const repaired = CastBackup.repairHistoryGrouping(imported.chatHistory, imported.characters);
                if (repaired.movedGroups) {
                    Object.keys(repaired.chatMembers).forEach(chatId => {
                        if (!imported.chatMembers[chatId]) {
                            imported.chatMembers[chatId] = repaired.chatMembers[chatId];
                        }
                    });
                    imported.chatHistory = repaired.chatHistory;
                }

                // Write everything, keeping track so we can undo on failure.
                const writes = [
                    [STORAGE_KEYS.CHARACTERS, imported.characters],
                    [STORAGE_KEYS.CHATS, imported.chats],
                    [STORAGE_KEYS.CHAT_HISTORY, imported.chatHistory],
                    [STORAGE_KEYS.LAST_ACTIVE_CHATS, imported.lastActiveChats],
                    [CastStorage.KEYS.CHAT_MEMBERS, imported.chatMembers],
                    [STORAGE_KEYS.PERSONAL_CONTEXT, imported.personalContext],
                ];

                const failed = [];
                writes.forEach(([key, value]) => {
                    const result = castStore.write(key, value);
                    if (!result.ok) failed.push({ key, reason: result.reason });
                });

                // Settings need care, because the file may be old. Merge rather
                // than replace, then bring the shape up to date.
                if (imported.settings && Object.keys(imported.settings).length) {
                    appSettings = { ...appSettings, ...imported.settings };
                }
                if (Object.keys(imported.apiKeys).length) {
                    appSettings.apiKeys = { ...(appSettings.apiKeys || {}), ...imported.apiKeys };
                    if (imported.apiKeys.gemini) {
                        state.apiKey = imported.apiKeys.gemini;
                        castStore.write(STORAGE_KEYS.API_KEY, state.apiKey);
                    }
                }

                if (failed.length) {
                    // Put things back the way they were.
                    const snapshot = CastStorage.readSnapshot(castStore);
                    if (snapshot) {
                        castStore.write(STORAGE_KEYS.CHARACTERS, snapshot.characters);
                        castStore.write(STORAGE_KEYS.CHATS, snapshot.chats);
                        castStore.write(STORAGE_KEYS.CHAT_HISTORY, snapshot.chatHistory);
                        castStore.write(STORAGE_KEYS.LAST_ACTIVE_CHATS, snapshot.lastActiveChats);
                        castStore.write(CastStorage.KEYS.CHAT_MEMBERS, snapshot.chatMembers);
                        throw new Error(
                            "There was not enough room for that backup, so nothing was changed and your existing data has been put back. Try removing some characters or pictures first."
                        );
                    }
                    throw new Error(
                        "Part of that backup could not be written and your previous data could not be restored. Save a backup of whatever is here before doing anything else."
                    );
                }

                // Migrate the settings shape, then persist.
                migrateSettingsShape();
                castStore.write(STORAGE_KEYS.SETTINGS, appSettings);

                const problemNote = checked.problems.length
                    ? ` Some parts were skipped: ${checked.problems.slice(0, 3).join(' ')}`
                    : '';

                recordActivity(CastLog.KINDS.BACKUP_LOADED, `${incoming.characterCount} characters, ${incoming.chatCount} chats, ${incoming.messageCount} messages`);
                if (checked.problems.length) {
                    recordActivity(CastLog.KINDS.IMPORT_PROBLEM, checked.problems.slice(0, 3).join(' '));
                }

                showSuccess(`Loaded ${incoming.characterCount} characters and ${incoming.chatCount} chats.${pictureNote}${problemNote} Reloading...`, 4000);

                setTimeout(() => window.location.reload(), 2600);
            } catch (error) {
                console.error("Could not load that backup:", error);
                showError(error.message);
            }
        };

        reader.onerror = () => showError("That file could not be read.");
        reader.readAsText(file);
    });

    fileInput.click();
}

// --- Backup reminders ---

function loadBackupState() {
    const result = castStore.read(CastStorage.KEYS.BACKUP_STATE, "object");
    state.backupState = Object.assign({
        lastBackupAt: null,
        changesSinceBackup: 0,
        snoozedUntil: null,
    }, result.value || {});

    // Session fields are not persisted, so they start fresh every time.
    state.backupState.sessionStartedAt = new Date().toISOString();
    state.backupState.remindedThisSession = false;
}

function maybeShowBackupReminder() {
    if (!state.backupState) return;

    const verdict = CastBackup.shouldRemindAboutBackup(state.backupState);
    if (!verdict.remind) return;

    const banner = document.getElementById('backup-reminder');
    const message = document.getElementById('backup-reminder-message');
    if (!banner || !message) return;

    message.textContent = verdict.message;
    banner.classList.remove('hidden');

    state.backupState.remindedThisSession = true;
}

function hideBackupReminder() {
    const banner = document.getElementById('backup-reminder');
    if (banner) banner.classList.add('hidden');
}

function dismissBackupReminder() {
    state.backupState = CastBackup.snoozeReminder(state.backupState);
    castStore.write(CastStorage.KEYS.BACKUP_STATE, state.backupState);
    hideBackupReminder();
}

function updateLastBackupStatus() {
    const element = document.getElementById('last-backup-status');
    if (!element || !state.backupState) return;
    // Recomputed whenever it is shown, and again whenever anything changes, because it
    // used to be written once at start up and then left to go stale. It would still say
    // no changes since the last backup after adding or deleting several characters.

    if (!state.backupState.lastBackupAt) {
        element.textContent = "You have not saved a backup yet.";
        return;
    }

    // Read from the log, so this describes what actually happened rather than relying on
    // a counter that was only updated in some of the places that change data.
    const summary = CastLog.summariseSince(state.activityLog, state.backupState.lastBackupAt);
    element.textContent = `Last backup ${CastLog.formatTime(state.backupState.lastBackupAt)}. ${summary}`;
}

// Checks every few minutes rather than on every keystroke, so it stays quiet.
function startBackupReminderTimer() {
    setInterval(maybeShowBackupReminder, 4 * 60 * 1000);
}

// The two extra controls on the edit panel.
function setupEditModalExtras() {
    const clearBtn = document.getElementById('edit-enhanced-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            const box = document.getElementById('edit-enhanced-context');
            if (!box || !box.value.trim()) return;

            const confirmed = await CastConfirm.ask({
                title: 'Clear the enhanced profile?',
                message: 'The character will fall back to the short description until you build it again.',
                confirmText: 'Clear it',
                tone: 'warning',
            });
            if (!confirmed) return;

            box.value = '';
            const meta = document.getElementById('edit-enhanced-meta');
            if (meta) meta.textContent = 'Cleared, not saved yet';
        });
    }

    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            const modal = document.getElementById('edit-character-modal');
            if (modal) modal.classList.add('hidden');
        });
    }

    // A running count as you type, so it is obvious the box holds real content.
    const box = document.getElementById('edit-enhanced-context');
    const meta = document.getElementById('edit-enhanced-meta');
    if (box && meta) {
        box.addEventListener('input', () => {
            const length = box.value.trim().length;
            meta.textContent = length
                ? `${length.toLocaleString()} characters, not saved yet`
                : 'Empty, will fall back to the description';
        });
    }
}

function setupProfilePictureHandlers() {
    // Setup for the create character form
    const profilePictureUpload = document.getElementById('profile-picture-upload');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const removeProfilePictureBtn = document.getElementById('remove-profile-picture');

    if (profilePictureUpload && profilePicturePreview) {
        // Handle file selection
        profilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // The limit is now much higher than the old 2MB, because the
                // picture gets shrunk before it is stored. What used to matter was
                // that a 2MB photo became roughly 2.7MB of text and ate over half
                // of the browser's storage allowance for the whole app. That is no
                // longer how pictures are kept, so a big original is fine.
                const maxSize = 12 * 1024 * 1024;
                if (file.size > maxSize) {
                    showError("That image is very large. Please pick one under 12MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = async function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("That image is too small. It needs to be at least 50 by 50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported. Please use a still image.");
                            return;
                        }

                        // Shrink it before it goes anywhere. A profile picture is
                        // shown at well under 200 pixels, so keeping a 4000 pixel
                        // original was pure waste.
                        let prepared = event.target.result;
                        try {
                            prepared = await CastImages.shrinkDataUrl(event.target.result);
                            const before = CastImages.estimateDataUrlBytes(event.target.result);
                            const after = CastImages.estimateDataUrlBytes(prepared);
                            if (before > after) {
                                console.log(`Picture shrunk from ${formatBytes(before)} to ${formatBytes(after)}.`);
                            }
                        } catch (error) {
                            console.warn("That picture could not be shrunk, using it as it is:", error);
                        }

                        // Held here until the character is saved, at which point it
                        // moves into the picture store.
                        state.pendingProfilePicture = prepared;

                        profilePicturePreview.innerHTML = '';
                        const preview = document.createElement('img');
                        preview.src = prepared;
                        preview.alt = 'Profile preview';
                        preview.className = 'w-full h-full object-cover';
                        profilePicturePreview.appendChild(preview);
                        profilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (removeProfilePictureBtn) {
                            removeProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (removeProfilePictureBtn) {
            removeProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                profilePictureUpload.value = '';

                // Forget the picture being held, otherwise removing it here and
                // then saving would still attach it.
                state.pendingProfilePicture = null;

                // Reset the preview
                profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                profilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                removeProfilePictureBtn.classList.add('hidden');
            });
        }
    }

    // Setup for the edit character modal
    const editProfilePictureUpload = document.getElementById('edit-profile-picture-upload');
    const editProfilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const editRemoveProfilePictureBtn = document.getElementById('edit-remove-profile-picture');

    if (editProfilePictureUpload && editProfilePicturePreview) {
        // Handle file selection
        editProfilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // Same reasoning as the create screen. The picture is shrunk
                // before it is stored, so a large original is not a problem.
                const maxSize = 12 * 1024 * 1024;
                if (file.size > maxSize) {
                    showError("That image is very large. Please pick one under 12MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = async function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("That image is too small. It needs to be at least 50 by 50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported. Please use a still image.");
                            return;
                        }

                        let prepared = event.target.result;
                        try {
                            prepared = await CastImages.shrinkDataUrl(event.target.result);
                        } catch (error) {
                            console.warn("That picture could not be shrunk, using it as it is:", error);
                        }

                        state.pendingEditProfilePicture = prepared;

                        editProfilePicturePreview.innerHTML = '';
                        const preview = document.createElement('img');
                        preview.src = prepared;
                        preview.alt = 'Profile preview';
                        preview.className = 'w-full h-full object-cover';
                        editProfilePicturePreview.appendChild(preview);
                        editProfilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (editRemoveProfilePictureBtn) {
                            editRemoveProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (editRemoveProfilePictureBtn) {
            editRemoveProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                editProfilePictureUpload.value = '';

                // Forget the picture being held, so removing it here and saving
                // actually removes it.
                state.pendingEditProfilePicture = null;

                // Reset the preview
                editProfilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                editProfilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                editRemoveProfilePictureBtn.classList.add('hidden');
            });
        }
    }
}

// Add this near the debounce function
function setupFocusHandling() {
    // Fix for mobile viewport issues - ensures viewport-fit=cover for notches
    const metaViewport = document.querySelector('meta[name=viewport]');
    if (metaViewport) {
        // Ensure width, initial-scale, and viewport-fit are set
        let content = metaViewport.content;
        if (!content.includes("width=device-width")) {
            content += ", width=device-width";
        }
        if (!content.includes("initial-scale=1.0")) {
            content += ", initial-scale=1.0";
        }
        if (!content.includes("viewport-fit=cover")) {
            content += ", viewport-fit=cover";
        }
        // Normalize by removing leading/trailing commas and spaces
        metaViewport.content = content.replace(/^,|,$/g, '').replace(/,\s*,/g, ',').trim();
    }

    const messageInput = document.getElementById('message-input');
    const body = document.body; // Use body from here

    // Detect if we're on iOS for specific resize logic
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (!messageInput) return;

    // Focus handling function - ensures input is visible when focused
    const handleFocus = () => {
        body.classList.add('keyboard-visible');

        // Set fixed position style for message container to prevent jumping (from old setupMobileViewportFix)
        const messageContainer = document.querySelector('.p-4.bg-white.border-t');
        if (messageContainer) {
            messageContainer.style.zIndex = '1000';
        }

        // Wait for keyboard to appear
        setTimeout(() => {
            // Generic scroll to the input field
            messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });

            // Scroll to bottom of chat window
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }, 300);
    };

    // Blur handling function - resets when keyboard is hidden
    const handleBlur = () => {
        body.classList.remove('keyboard-visible');
    };

    // Add event listeners
    messageInput.addEventListener('focus', handleFocus);
    messageInput.addEventListener('blur', handleBlur);

    // Setup resize event listener for keyboard detection on Android (non-IOS devices)
    if (!isIOS) {
        const initialHeight = window.innerHeight;
        window.addEventListener('resize', debounce(() => {
            // If height is significantly smaller, keyboard is likely visible
            if (window.innerHeight < initialHeight * 0.75) {
                body.classList.add('keyboard-visible');

                // Adjust messages container position
                setTimeout(() => {
                    if (messageInput) { // Check if messageInput is still valid
                        messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });
                    }
                }, 100);
            } else {
                body.classList.remove('keyboard-visible');
            }
        }, 100));
    }
}

// Helper function to clean up pending responses and ensure they don't get lost
function cleanupPendingResponses() {
    // Clean up any pending responses that have completed but weren't cleaned properly
    for (const characterId in state.pendingResponses) {
        const pendingData = state.pendingResponses[characterId];
        if (!pendingData.isGenerating) {
            delete state.pendingResponses[characterId];
        }
    }
}
