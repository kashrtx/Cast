// Settings that are not about a provider.
//
// What the app should call you and know about you, which goes into every conversation, and how much
// room is left in storage. Small, and separate from the provider settings on purpose, because that
// is the part people actually come to this screen to change.

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
