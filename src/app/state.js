// The data the whole app works from.
//
// There are two objects. `appSettings` is what you chose: provider, keys, models, token limits.
// `state` is what is happening right now: the characters, the chats, which chat is open, what is
// still loading. Settings are written to storage and survive a reload. Most of state does not.
//
// They are deliberately in a file of their own and deliberately first in the load order, so that
// "where does this value live" has one answer. If you are adding a feature that needs to remember
// something, add the field here with a comment saying what it is for, rather than hanging a new
// global somewhere else.

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
    // How long to wait on a provider before giving up, in seconds. There was no limit at all before,
    // so a provider that went quiet left the app showing "Connecting..." for good.
    requestTimeoutSeconds: 150,
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
