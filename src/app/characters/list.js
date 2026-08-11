// Drawing the characters, and choosing who is in a chat.
//
// One row is built in one place and used by both the main page and the sidebar, so a change to how
// a character is shown is a change in one function. Selecting more than one is how a group chat
// starts, so the selection state lives here too.

// Helper function to set up event listeners for character items
function setupCharacterItemListeners() {
    // Set up enhance button event listeners
    document.querySelectorAll('[id^="enhance-btn-"]').forEach(button => {
        const characterId = button.id.replace('enhance-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            enhanceCharacterContext(characterId);
        });
    });

    // Set up edit button event listeners
    document.querySelectorAll('[id^="edit-btn-"]').forEach(button => {
        const characterId = button.id.replace('edit-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', (e) => {
            e.preventDefault();
            editCharacter(characterId);
        });
    });

    // Set up delete button event listeners
    document.querySelectorAll('[id^="delete-btn-"]').forEach(button => {
        const characterId = button.id.replace('delete-btn-', '');

        // Remove existing event listeners by cloning and replacing
        const newButton = button.cloneNode(true);
        button.parentNode.replaceChild(newButton, button);

        newButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await deleteCharacter(characterId);
        });
    });
}

// Function to generate HTML for character list
function generateCharacterListHTML() {
    // Uses the same card as everywhere else, so the three copies of this markup that used to
    // drift apart are now one.
    return state.characters.map(characterCardHTML).join('');
}

// Character selection in sidebar
function toggleCharacterSelection(characterId) {
    console.log("Character selected:", characterId);

    // Check if character exists
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        console.error("Character not found:", characterId);
        return;
    }

    // Check if this character is already selected
    const wasSelected = state.selectedCharacters.includes(characterId);

    // Save the previous active chat to clean up in-progress system messages
    const previousActiveChat = state.activeChat;

    // Single-character mode is enforced. Selecting a character replaces the current chat target.
    state.selectedCharacters = [characterId];

    // Update UI to reflect selection state
    updateSidebarCharacters();

    // Close the sidebar on mobile after character selection
    if (window.innerWidth <= 768) {
        const sidebar = document.getElementById('character-sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar && sidebar.classList.contains('sidebar-open')) {
            sidebar.classList.remove('sidebar-open');
            // No need to manage overlay on mobile as it's hidden via CSS
        }
    }

    // If we're removing a character from an active chat
    if (wasSelected && state.selectedCharacters.length === 0) {
        // Show placeholder, hide chat
        const chatWindow = document.getElementById('chat-window');
        const placeholder = document.getElementById('chat-placeholder');

        if (chatWindow) { chatWindow.classList.add('hidden'); }
        if (placeholder) { placeholder.classList.remove('hidden'); }

        // Force a layout refresh
        setTimeout(() => {
            window.dispatchEvent(new Event('resize'));
        }, 10);
    }

    // Clean up any completed pending responses 
    cleanupPendingResponses();

    // Clean up any "continuing conversation" system messages in the previous chat
    if (previousActiveChat && state.chats[previousActiveChat]) {
        const messages = state.chats[previousActiveChat];
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

    // Auto-start chat in single character mode
    if (state.selectedCharacters.length === 1) {
        console.log("Auto-starting chat since character was selected");

        // Ensure the character's chat reference is maintained
        ensureCharacterChatReference(characterId);

        // Check if there's a last active chat for this character
        const lastChatId = state.lastActiveChats[characterId];

        if (lastChatId && state.chats[lastChatId]) {
            console.log("Resuming last active chat:", lastChatId);

            // Set as active chat
            state.activeChat = lastChatId;

            // Update active characters
            state.activeCharacters = state.characters.filter(c => state.selectedCharacters.includes(c.id)).slice(0, 1);

            // Ensure the chat has at least one message (add a welcome message if empty)
            if (state.chats[lastChatId].length === 0) {
                const welcomeMsg = {
                    id: generateUniqueId(),
                    content: `Starting conversation with ${state.activeCharacters.map(c => c.name).join(', ')}.`,
                    isUser: false,
                    isSystem: true,
                    timestamp: new Date().toISOString(),
                    isDeleted: false
                };

                state.chats[lastChatId].push(welcomeMsg);
                setStoredItem(STORAGE_KEYS.CHATS, state.chats);
            }

            // Update UI
            changeView('chat');
            updateChatUI();
        } else {
            // Start a new chat if no last active chat exists
            startChat();
        }
    }
}

function updateCharacterLists() {
    console.log("Updating character lists with", state.characters.length, "characters");
    if (document.readyState !== 'complete' && document.readyState !== 'interactive') {
        console.log("DOM not ready, deferring character list update");
        document.addEventListener('DOMContentLoaded', updateCharacterLists);
        return;
    }
    try {
        // This part is for the main "Characters" view
        renderFilteredAndSortedCharacters();

        // This updates the sidebar, which has its own sorting logic
        updateSidebarCharacters();

        // If we're in an active chat with no data, reset the active chat
        if (state.activeChat && (!state.chats[state.activeChat] || state.chats[state.activeChat].length === 0)) {
            // Check if any characters in activeChat were deleted
            const chatCharIds = state.activeChat.split('-');
            const allExist = chatCharIds.every(id => state.characters.some(c => c.id === id));

            if (!allExist) {
                // Reset the active chat and update UI
                state.activeChat = null;
                state.activeCharacters = [];
                updateChatUI();
            }
        }
    } catch (error) {
        console.error("Error updating character lists:", error);
        // Try to recover by refreshing the whole page if critical error
        if (error.toString().includes("TypeError")) {
            console.log("Critical error detected, suggesting page refresh");
            showError("An error occurred. Please refresh the page.");
        }
    }
}

// (Adapted from generateCharacterListHTML and setupCharacterItemListeners)
// One character card, built in one place.
//
// There were three copies of this markup with slightly different structures, which is why
// the layout kept going wrong in ways that were hard to pin down. The classes here are
// purpose made rather than borrowed, so the stylesheet matches what is generated instead of
// guessing at it.
//
// Two things the old markup got wrong. The name sat in a flex box with no minimum width, so
// a long name could not shrink and pushed the edit and delete controls outside the card. And
// the description was inserted without escaping, so anything in a character description was
// treated as markup.
function characterCardHTML(character) {
    const safeName = CastEscape.escapeHtml(character.name);
    const picture = CastEscape.safeImageUrl(getCharacterPicture(character));
    const id = CastEscape.escapeAttribute(character.id);

    const avatar = picture
        ? `<img src="${picture}" alt="${safeName}" loading="lazy" class="char-avatar">`
        : `<div class="char-avatar char-avatar-letter">${CastEscape.initial(character.name)}</div>`;

    const described = String(character.userContext || '').trim();
    const enhanced = String(character.enhancedContext || '').trim();

    return `
    <div class="char-card" id="character-item-${id}">
        <div class="char-card-top">
            ${avatar}
            <h3 class="char-card-name" title="${safeName}">${safeName}</h3>
            <div class="char-card-actions">
                <button id="edit-btn-${id}" class="char-icon-btn char-icon-edit" title="Edit ${safeName}" aria-label="Edit ${safeName}">
                    <i class="fas fa-pen"></i>
                </button>
                <button id="delete-btn-${id}" class="char-icon-btn char-icon-delete" title="Delete ${safeName}" aria-label="Delete ${safeName}">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>

        <div class="char-card-field">
            <p class="char-card-label">Description</p>
            <div class="char-card-text">${described ? CastEscape.escapeHtml(described) : '<span class="char-card-empty">Nothing written yet</span>'}</div>
        </div>

        <div class="char-card-foot">
            <p class="char-card-badge ${enhanced ? 'is-built' : 'is-plain'}" id="enhanced-context-${id}"
               title="${enhanced ? 'A fuller profile has been written. Open Edit to read or change it.' : 'Only the short description is in use.'}">
                <i class="fas ${enhanced ? 'fa-circle-check' : 'fa-circle-minus'}"></i>
                ${enhanced
                    ? `Profile built, ${Math.round(enhanced.length / 100) / 10}k characters`
                    : 'Using the description only'}
            </p>
            <button id="enhance-btn-${id}" class="char-enhance-btn">
                <i class="fas fa-wand-magic-sparkles"></i>
                ${enhanced ? 'Rebuild profile' : 'Build profile'}
            </button>
        </div>
    </div>`;
}

function createCharacterItemHTML(character) {
    return characterCardHTML(character);
}

function displayCharactersInMainList(charactersToDisplay) {
    const characterListContainer = document.getElementById('character-list');

    if (!characterListContainer) {
        console.error("Character list container not found!");
        return;
    }

    // Always say when a search is hiding some of them, and offer a way out.
    showFilterNotice(
        'character-filter-notice',
        characterListContainer,
        state.characterSearchTerm,
        charactersToDisplay.length,
        (state.characters || []).length,
        clearCharacterSearch
    );

    if (charactersToDisplay.length === 0) {
        let message = "No characters created yet. Create one to get started!";
        if (state.characterSearchTerm && state.characterSearchTerm.trim() !== "") {
            message = `Nothing matches "${state.characterSearchTerm.trim()}". Clear the search to see all ${(state.characters || []).length} of them.`;
        }
        // Set the innerHTML to the "no characters" message.
        // Ensure the <p> tag has the id 'no-characters' if other parts of the code expect it,
        // though with this direct management, the id might become less critical for this specific function.
        characterListContainer.innerHTML = `<p id="no-characters" class="text-gray-500 italic">${message}</p>`;
    } else {
        // Set the innerHTML to the list of characters.
        // This implicitly removes the "no-characters" paragraph if it was there.
        characterListContainer.innerHTML = charactersToDisplay.map(character => createCharacterItemHTML(character)).join('');

        // Re-attach event listeners for the newly rendered items
        charactersToDisplay.forEach(character => {
            const editBtn = document.getElementById(`edit-btn-${character.id}`);
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    editCharacter(character.id);
                });
            }
            const deleteBtn = document.getElementById(`delete-btn-${character.id}`);
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await deleteCharacter(character.id);
                });
            }
            const enhanceBtn = document.getElementById(`enhance-btn-${character.id}`);
            if (enhanceBtn) {
                enhanceBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    enhanceCharacterContext(character.id);
                });
            }
        });
    }
}


function renderFilteredAndSortedCharacters() {
    // Only render if the characters view is active and visible
    // Also render if the initial load is happening (DOM content loaded)
    const charactersView = document.getElementById('characters-view');
    // We need to render on initial load even if characters view is hidden
    // because the initial view is often chat, but the character list
    // needs to be populated for the filter/sort controls to work correctly
    // if the user switches views later.
    let processedCharacters = [...state.characters];
    processedCharacters = filterCharacters(processedCharacters, state.characterSearchTerm);
    processedCharacters = sortCharacters(processedCharacters, state.characterSortOrder);
    displayCharactersInMainList(processedCharacters);
}
