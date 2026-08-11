// Keeping past conversations, and getting back into one.
//
// Starting a new chat with someone does not throw away the old one. The current chat is written to
// history when you leave it, and can be reopened as it was.
//
// Note that a chat is filed against the characters in it, from the membership on the record, rather
// than against anything parsed out of its ID. Getting that wrong is what once made old chats
// unreachable.

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
