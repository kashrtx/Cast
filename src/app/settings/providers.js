// Choosing a provider and a model, and saying what is wrong when it will not connect.
//
// The list of providers comes from src/providers.js, so adding one is a change there rather than
// here. What this file does is show the right fields for whichever is chosen, since a hosted
// service needs a key and a local one needs an address, offer the models the service says it has,
// and warn before a token limit is set higher than the model will take.
//
// The model box is a free text field on purpose. A new model can be typed the day it appears
// without waiting for the app to hear about it.

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

    // How long to wait before giving up. Read as typed and then brought into range when it is used, so
    // a nonsense value here can never mean no limit at all, which is what the app had before.
    const timeoutInput = document.getElementById('request-timeout');
    if (timeoutInput) {
        const seconds = Number(timeoutInput.value);
        if (Number.isFinite(seconds) && seconds > 0) {
            appSettings.requestTimeoutSeconds = seconds;
        }
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
    const reasoningDefault = document.getElementById('show-reasoning-default');

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

    const requestTimeout = document.getElementById('request-timeout');
    if (requestTimeout) {
        requestTimeout.value = Math.round(getRequestTimeoutMs() / 1000);
        requestTimeout.addEventListener('change', () => {
            saveVisibleProviderSettings({ reinitialize: false });
        });
    }

    if (includeKeyCheckbox) {
        includeKeyCheckbox.checked = Boolean(appSettings.includeKeyInBackups);
    }

    if (reasoningDefault) {
        reasoningDefault.checked = Boolean(appSettings.showReasoningByDefault);
        reasoningDefault.addEventListener('change', (e) => {
            appSettings.showReasoningByDefault = e.target.checked;
            saveAppSettings({ reinitialize: false });
            updateChatMessages();
        });
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
