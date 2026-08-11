// Working out which provider is in use and what it has been given.
//
// Every question of the form "what key, model or address should this request use" is answered here,
// and nowhere else. Keys, models and addresses are all kept per provider, so you can set several up
// and switch between them without pasting anything again.
//
// Nothing in here makes a request. It only reads settings and reports what is missing, which is
// what lets the connect screen explain the problem before anything is sent.

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
