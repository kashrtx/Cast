// Opening a chat, starting a new one, and clearing one out.
//
// A chat is one character or several, and both go through the same path so a group chat is not a
// separate kind of thing with its own bugs. Opening one restores where you were, which is why the
// last chat per character is remembered.

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

    // Anything left looking like it is still writing, when nothing is, goes now. Opening a chat is
    // when you would see it, so it is where the check belongs.
    try { clearStuckTypingIndicators(); } catch (error) { console.warn(error); }

    // Update messages
    updateChatMessages(); // This function populates the messages

    const messagesContainer = document.getElementById('chat-messages');
    if (messagesContainer) {
        requestAnimationFrame(() => { // Defer scroll to next frame
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        });
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
