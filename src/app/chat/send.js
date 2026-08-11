// Sending, and everything that happens while you wait.
//
// sendMessage is the front of the chat: it takes what you typed, puts it on screen straight away,
// and asks whoever is in the chat to reply. Who replies and in what order, for a group chat, is
// decided in src/group.js.
//
// The rest of the file is the wait. A reply can take a while, so there is a typing indicator with a
// status that changes as time passes, and a way to clear all of it if the reply never comes. Anyone
// who has watched an indicator that never goes away knows why that last part is written out
// carefully.

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

// Helper function to clean up pending responses and ensure they don't get lost
// Clears any typing indicator that nothing is working on.
//
// The indicators are removed by the code that put them there, on every path. This is the backstop for
// the paths nobody has found: a reload in the middle of a reply, a failure in a branch that returns
// rather than throwing, a browser tab suspended by the phone and woken later. In every one of those
// the message is in stored data with isTyping set and no generation behind it, and it will sit there
// looking like the character is still writing until something takes it away.
//
// Called when a chat is opened and after start up, which is when it would be seen.
function clearStuckTypingIndicators() {
    const generatingChats = new Set();
    Object.keys(state.pendingResponses || {}).forEach(characterId => {
        const pending = state.pendingResponses[characterId];
        if (pending && pending.isGenerating && pending.chatId) generatingChats.add(pending.chatId);
    });

    let removed = 0;
    Object.keys(state.chats || {}).forEach(chatId => {
        const messages = state.chats[chatId];
        if (!Array.isArray(messages)) return;
        // A chat with a reply genuinely on its way is left alone.
        if (generatingChats.has(chatId)) return;

        for (let i = messages.length - 1; i >= 0; i -= 1) {
            if (messages[i] && messages[i].isTyping) {
                messages.splice(i, 1);
                removed += 1;
            }
        }
    });

    if (removed) {
        setStoredItem(STORAGE_KEYS.CHATS, state.chats);
        console.log(`Cleared ${removed} typing indicator(s) that nothing was working on.`);
        if (state.activeChat) updateChatMessages();
    }
    return removed;
}

function cleanupPendingResponses() {
    // Clean up any pending responses that have completed but weren't cleaned properly
    for (const characterId in state.pendingResponses) {
        const pendingData = state.pendingResponses[characterId];
        if (!pendingData.isGenerating) {
            delete state.pendingResponses[characterId];
        }
    }
}
