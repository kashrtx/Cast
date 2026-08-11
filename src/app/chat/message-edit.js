// Changing a message after it was sent, and taking one back.
//
// A message that is deleted is marked rather than removed, so what the model is told matches what
// you can see. Editing rewrites the text in place for the same reason: the next reply is built from
// what is on screen now, not from what was originally said.

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
