// Turning messages into what you see.
//
// One message becomes one block of markup here. Markdown is turned into the formatting in
// src/markdown.js and then cleaned before it goes anywhere near the page, because the text came
// from a model and is not trusted.
//
// updateMessageContent is the one to know about: it is called repeatedly while a reply streams in,
// so it has to be cheap and it has to leave the page where it was rather than jumping.

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

        // Reasoning never shares the dialogue bubble and is never treated as
        // something the character said. A native disclosure keeps it compact,
        // keyboard accessible, and individually showable/hideable.
        if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
            const reasoningDetails = createElement('details', ['reasoning-disclosure']);
            reasoningDetails.open = Boolean(appSettings.showReasoningByDefault);
            const reasoningSummary = createElement('summary', ['reasoning-summary']);
            reasoningSummary.textContent = 'Model thinking';
            const reasoningText = createElement('div', ['reasoning-text']);
            reasoningText.textContent = message.reasoning.trim();
            reasoningDetails.appendChild(reasoningSummary);
            reasoningDetails.appendChild(reasoningText);
            messageContainerInner.appendChild(reasoningDetails);
        }


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
