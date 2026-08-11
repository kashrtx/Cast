// Reading everything back at start up, whatever shape it is in.
//
// This has to cope with data written by every earlier version of the app, and with data that is
// damaged. The rule it follows is that nothing is ever thrown away because it looked wrong: a chat
// whose character is missing is kept aside rather than deleted, and a settings field that has
// changed shape is moved rather than reset.
//
// If you are adding a settings field, give it a default in state.js and, if it replaces an older
// field, move it across in migrateSettingsShape.

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
