// Writing a character, and changing one later.
//
// Creating and editing share this file because they are the same form with different starting
// values and different endings, and keeping them apart is how they drift until one of them
// validates something the other does not.
//
// An edit takes effect on the next message, not the next chat, because the record is written back
// to state and everything that sends a message re-reads it from there.

// Character management
function createNewCharacter() {
    // Get input fields
    const nameInput = document.getElementById('character-name');
    const contextInput = document.getElementById('character-context');

    if (!nameInput || !contextInput) {
        showError("Character creation form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();

    // Better validation with more specific error messages
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // The picture is held in state by the upload handler, already shrunk. Read
    // the preview as a fallback for the case where it was set some other way.
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    let profilePicture = state.pendingProfilePicture || null;

    if (!profilePicture && profilePicturePreview && profilePicturePreview.querySelector('img')) {
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Create new character.
    //
    // Note that the picture is not part of this record. It goes into its own
    // store, which is why adding characters no longer eats into the small
    // allowance the browser gives us for chats and settings.
    const newCharacter = {
        id: generateUniqueId(),
        name,
        userContext: context,
        enhancedContext: null,
        hasPicture: Boolean(profilePicture),
        createdAt: new Date().toISOString(),
    };

    console.log("Creating new character:", newCharacter.name);
    recordActivity(CastLog.KINDS.CHARACTER_ADDED, newCharacter.name);

    if (profilePicture) {
        CastImages.putPicture(newCharacter.id, profilePicture)
            .then(() => {
                state.pictureCache[newCharacter.id] = profilePicture;
                updateCharacterLists();
                updateSidebarCharacters();
            })
            .catch(error => {
                console.warn("That picture could not be saved:", error);
                recordActivityIfReady(CastLog.KINDS.PICTURE_PROBLEM, `could not save the picture for ${newCharacter.name}: ${error.message}`);
                showError("The character was saved but the picture could not be. Try a different image.");
            });
    }
    state.pendingProfilePicture = null;

    // Add to state and save
    state.characters.push(newCharacter);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Clear inputs AFTER validation and saving
    nameInput.value = '';
    contextInput.value = '';

    // Reset profile picture preview
    if (profilePicturePreview) {
        profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
        profilePicturePreview.classList.remove('has-image');

        // Hide the remove button
        const removeButton = document.getElementById('remove-profile-picture');
        if (removeButton) {
            removeButton.classList.add('hidden');
        }
    }

    // Show success message
    showSuccess(`Character "${name}" created successfully!`);

    // Instead of re-rendering the entire list, append the new element:
    const characterListContainer = document.getElementById('character-list');
    if (characterListContainer) {
        // Remove "no characters" message if present
        const noChars = document.getElementById('no-characters');
        if (noChars) { noChars.remove(); }

        // Create a new div element for the character
        const newCharDiv = document.createElement('div');
        newCharDiv.id = `character-item-${newCharacter.id}`;
        newCharDiv.className = "border rounded-lg p-4 hover:shadow-md transition";

        // Determine how to display the character avatar
        const newSafeName = CastEscape.escapeHtml(newCharacter.name);
        const newPicture = CastEscape.safeImageUrl(profilePicture || getCharacterPicture(newCharacter));
        let avatarHTML = '';
        if (newPicture) {
            avatarHTML = `<img src="${newPicture}" alt="${newSafeName}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${CastEscape.initial(newCharacter.name)}</div>`;
        }

        newCharDiv.innerHTML = `
            <div class="flex justify-between items-start">
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${newCharacter.name}</h3>
                </div>
                <div class="flex space-x-2">
                    <button id="edit-btn-${newCharacter.id}" class="text-blue-500 hover:text-blue-700" title="Edit character">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button id="delete-btn-${newCharacter.id}" class="text-red-500 hover:text-red-700" title="Delete character">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>

            <div class="mt-2">
                <p class="text-sm text-gray-700 font-semibold">User-Provided Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-32 overflow-auto p-1 border rounded bg-gray-50">
                    ${newCharacter.userContext}
                </div>
            </div>

            ${newCharacter.enhancedContext ? `
            <div class="mt-3 bg-gray-50 p-2 rounded enhanced-context" id="enhanced-context-${newCharacter.id}">
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${newCharacter.enhancedContext}
                </div>
            </div>
            ` : ''}

            <div class="mt-3 flex justify-center">
                <button id="enhance-btn-${newCharacter.id}" class="text-sm bg-secondary text-white px-3 py-1 rounded hover:bg-secondary/90 transition ${!isProviderConfigured() ? 'disabled:bg-gray-400' : ''}" ${!isProviderConfigured() ? 'disabled' : ''}>
                    <i class="fas fa-magic mr-1"></i> ${newCharacter.enhancedContext ? 'Re-Enhance Context' : 'Enhance Context'}
                </button>
            </div>
        `;

        // Append the new character element to the container
        characterListContainer.appendChild(newCharDiv);

        // Set up event listeners for the new element:
        const editBtn = newCharDiv.querySelector(`#edit-btn-${newCharacter.id}`);
        if (editBtn) {
            editBtn.addEventListener('click', (e) => {
                e.preventDefault();
                editCharacter(newCharacter.id);
            });
        }

        const deleteBtn = newCharDiv.querySelector(`#delete-btn-${newCharacter.id}`);
        if (deleteBtn) {
            deleteBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await deleteCharacter(newCharacter.id);
            });
        }

        const enhanceBtn = newCharDiv.querySelector(`#enhance-btn-${newCharacter.id}`);
        if (enhanceBtn) {
            enhanceBtn.addEventListener('click', (e) => {
                e.preventDefault();
                enhanceCharacterContext(newCharacter.id);
            });
        }
    }

    // Also update the sidebar if needed
    updateSidebarCharacters();

    // Full UI update
    updateCharacterLists();
    window.scrollTo(0, document.body.scrollHeight); // scroll to bottom to see new character

    // If the characters view is currently hidden, switch to it
    if (document.getElementById('characters-view').classList.contains('hidden')) {
        changeView('characters');
    }
    return true;
}

// After the dismissError function
function editCharacter(characterId) {
    console.log("Editing character:", characterId);

    // Start clean. Without this, opening one character, picking a picture, closing
    // without saving, then opening a different character would carry the first
    // picture across to the second.
    state.pendingEditProfilePicture = null;

    // Find character in state
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("That character could not be found.");
        return;
    }

    // The enhanced profile, so you can read it and change it rather than only rebuilding it.
    const enhancedInput = document.getElementById('edit-enhanced-context');
    const enhancedMeta = document.getElementById('edit-enhanced-meta');
    if (enhancedInput) {
        const enhanced = String(character.enhancedContext || '');
        enhancedInput.value = enhanced;
        if (enhancedMeta) {
            enhancedMeta.textContent = enhanced
                ? `${enhanced.length.toLocaleString()} characters, in use`
                : 'Not built yet';
        }
    }

    // Populate the edit form
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    nameInput.value = character.name;
    contextInput.value = character.userContext;
    idInput.value = character.id;

    // Set profile picture if available
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const removeButton = document.getElementById('edit-remove-profile-picture');

    if (profilePicturePreview) {
        const editPicture = getCharacterPicture(character);
        if (editPicture) {
            // Built as a node so the name never needs escaping.
            profilePicturePreview.innerHTML = '';
            const img = document.createElement('img');
            img.src = editPicture;
            img.alt = character.name;
            img.className = 'w-full h-full object-cover';
            profilePicturePreview.appendChild(img);
            profilePicturePreview.classList.add('has-image');

            // Show the remove button
            if (removeButton) {
                removeButton.classList.remove('hidden');
            }
        } else {
            // Display the default icon
            profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
            profilePicturePreview.classList.remove('has-image');

            // Hide the remove button
            if (removeButton) {
                removeButton.classList.add('hidden');
            }
        }
    }

    // Show the edit modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.remove('hidden');
    }
}

function saveEditedCharacter() {
    // Get input fields
    const nameInput = document.getElementById('edit-character-name');
    const contextInput = document.getElementById('edit-character-context');
    const idInput = document.getElementById('edit-character-id');

    if (!nameInput || !contextInput || !idInput) {
        showError("Edit form elements not found");
        return;
    }

    const name = nameInput.value.trim();
    const context = contextInput.value.trim();
    const id = idInput.value;

    // Validate inputs
    if (name === '') {
        showError("Please provide a name for your character");
        nameInput.focus();
        return false;
    }

    if (context === '') {
        showError("Please provide context for your character");
        contextInput.focus();
        return false;
    }

    // The upload handler leaves the shrunk picture here. Fall back to reading the
    // preview for the case where the picture was not changed this time round.
    const profilePicturePreview = document.getElementById('edit-profile-picture-preview');
    let profilePicture = state.pendingEditProfilePicture || null;

    if (!profilePicture && profilePicturePreview && profilePicturePreview.querySelector('img')) {
        profilePicture = profilePicturePreview.querySelector('img').src;
    }

    // Find character in state and update it
    const characterIndex = state.characters.findIndex(c => c.id === id);
    if (characterIndex === -1) {
        showError("That character could not be found.");
        return;
    }

    // Store old name for success message
    const oldName = state.characters[characterIndex].name;
    const oldEnhancedContext = state.characters[characterIndex].enhancedContext; // Store old enhanced context

    // Update character and REMOVE the enhanced context since we've changed the user context
    state.characters[characterIndex].name = name;
    state.characters[characterIndex].userContext = context;
    // The enhanced profile is whatever is in the box.
    //
    // Editing a character used to discard it outright, on the grounds that the description had
    // changed. That meant any hand written wording was lost the moment you corrected a typo in
    // a name. It is editable now, so it is saved like any other field.
    const editedEnhanced = document.getElementById('edit-enhanced-context');
    const enhancedValue = editedEnhanced ? String(editedEnhanced.value).trim() : '';
    state.characters[characterIndex].enhancedContext = enhancedValue || null;
    state.characters[characterIndex].hasPicture = Boolean(profilePicture);
    recordActivity(CastLog.KINDS.CHARACTER_EDITED, name);

    // Any picture still sitting on the record from an older version is dropped,
    // because the picture now lives in its own store.
    delete state.characters[characterIndex].profilePicture;

    if (profilePicture) {
        CastImages.putPicture(id, profilePicture)
            .then(() => { state.pictureCache[id] = profilePicture; })
            .catch(error => {
                console.warn("That picture could not be saved:", error);
                showError("The changes were saved but the picture could not be. Try a different image.");
            });
    } else {
        // The picture was removed, so take it out of the store as well rather
        // than leaving it behind taking up room.
        CastImages.deletePicture(id).catch(() => {});
        delete state.pictureCache[id];
    }
    state.pendingEditProfilePicture = null;

    // IMPORTANT: Update the character in the activeCharacters array as well
    // This ensures the chat immediately uses the new context
    if (state.activeCharacters) {
        const activeCharIndex = state.activeCharacters.findIndex(c => c.id === id);
        if (activeCharIndex !== -1) {
            // Update the active character with the new data
            // The live record itself, not a copy of it. Spreading it into a new
            // object here used to break the link, so later changes such as an
            // enhanced profile never reached the chat.
            state.activeCharacters[activeCharIndex] = state.characters[characterIndex];
            console.log("Updated active character with new context");
        }
    }

    // If name changed and character is in selected characters, update the chat title
    if (oldName !== name && state.selectedCharacters.includes(id)) {
        updateChatUI();
    }

    // Save to storage
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Update the specific character element directly for immediate feedback
    const charElement = document.getElementById(`character-item-${id}`);
    if (charElement) {
        // Determine how to display the character avatar
        const editedSafeName = CastEscape.escapeHtml(name);
        const editedPicture = CastEscape.safeImageUrl(profilePicture);
        let avatarHTML = '';
        if (editedPicture) {
            avatarHTML = `<img src="${editedPicture}" alt="${editedSafeName}" class="w-10 h-10 rounded-full object-cover mr-3">`;
        } else {
            avatarHTML = `<div class="character-avatar bg-primary/20 text-primary mr-3">${CastEscape.initial(name)}</div>`;
        }

        // Find and update the character header with name and avatar
        const headerElement = charElement.querySelector('.flex.justify-between.items-start');
        if (headerElement) {
            const nameWithAvatarHTML = `
                <div class="flex items-center">
                    ${avatarHTML}
                    <h3 class="font-bold text-lg">${name}</h3>
                </div>
            `;

            // Replace the first child (which should be either the name or the flex container with avatar and name)
            const firstChild = headerElement.firstElementChild;
            if (firstChild) {
                // Create a temporary container
                const temp = document.createElement('div');
                temp.innerHTML = nameWithAvatarHTML.trim();

                // Replace the first child with our new element
                headerElement.replaceChild(temp.firstElementChild, firstChild);
            }
        }

        // Find and update the user context
        const contextElement = charElement.querySelector('.text-gray-600.text-sm.mt-1.max-h-32');
        if (contextElement) {
            contextElement.textContent = context;
        }

        // Remove enhanced context if it exists
        const enhancedContextElement = charElement.querySelector(`#enhanced-context-${id}`);
        if (enhancedContextElement) {
            enhancedContextElement.remove();
        }

        // Update enhance button text (since enhanced context was removed)
        const enhanceBtn = charElement.querySelector(`#enhance-btn-${id}`);
        if (enhanceBtn) {
            enhanceBtn.innerHTML = '<i class="fas fa-magic mr-1"></i> Enhance Context';
        }
    }

    // Update sidebar character for immediate feedback
    const sidebarCharElement = document.getElementById(`sidebar-char-${id}`);
    if (sidebarCharElement) {
        // Update the name
        const sidebarNameElement = sidebarCharElement.querySelector('.text-sm.font-medium');
        if (sidebarNameElement) {
            sidebarNameElement.textContent = name;
        }

        // Update the avatar
        const avatarElement = sidebarCharElement.querySelector('.character-avatar');
        if (avatarElement) {
            if (profilePicture) {
                avatarElement.innerHTML = '';
                const sidebarImg = document.createElement('img');
                sidebarImg.src = profilePicture;
                sidebarImg.alt = name;
                sidebarImg.className = 'w-full h-full object-cover';
                avatarElement.appendChild(sidebarImg);
                avatarElement.classList.add('has-image');
            } else {
                avatarElement.textContent = (name || "?").trim().charAt(0).toUpperCase() || "?";
                avatarElement.classList.remove('has-image');
            }
        }
    }

    // Update UI
    updateSidebarCharacters();
    renderFilteredAndSortedCharacters(); // Re-render the main list if filters/sorts are active

    // Close the modal
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        modal.classList.add('hidden');
    }

    // Notify in active chat if the character is part of it
    if (state.activeChat && state.activeChat.includes(id)) {
        let notificationContent = `System: ${name}'s context has been updated.`;
        if (oldEnhancedContext) {
            notificationContent += " The character's enhanced context was cleared and may need to be re-generated from the new base context.";
        }
        notificationContent += " The new details will apply to future messages in this chat.";

        const systemMessage = {
            id: generateUniqueId(),
            content: notificationContent,
            isUser: false,
            isSystem: true,
            timestamp: new Date().toISOString(),
            isDeleted: false
        };
        addMessage(systemMessage);
    }

    // Show success message
    showSuccess(`Character "${oldName}" updated to "${name}" successfully!`);
}

function setupEditCharacterModal() {
    // Set up close button
    const closeButton = document.getElementById('close-edit-modal');
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            const modal = document.getElementById('edit-character-modal');
            if (modal) {
                modal.classList.add('hidden');
            }
        });
    }

    // Set up save button
    const saveButton = document.getElementById('save-character-btn');
    if (saveButton) {
        saveButton.addEventListener('click', saveEditedCharacter);
    }

    // Close modal when clicking outside
    //
    // A plain click handler on the backdrop is not enough. Selecting text inside the panel and
    // letting go anywhere outside it produces a click whose target is the backdrop, so the panel
    // closed and the edit was lost. Dragging a scrollbar did the same.
    //
    // The press and the release both have to be on the backdrop for it to count as clicking away.
    const modal = document.getElementById('edit-character-modal');
    if (modal) {
        let pressedOnBackdrop = false;

        modal.addEventListener('mousedown', (e) => {
            pressedOnBackdrop = e.target === modal;
        });

        // A touch that starts on the backdrop counts the same way.
        modal.addEventListener('touchstart', (e) => {
            pressedOnBackdrop = e.target === modal;
        }, { passive: true });

        modal.addEventListener('click', (e) => {
            const releasedOnBackdrop = e.target === modal;
            const wasDrag = Boolean(
                typeof window !== 'undefined'
                && window.getSelection
                && String(window.getSelection())
            );

            if (pressedOnBackdrop && releasedOnBackdrop && !wasDrag) {
                modal.classList.add('hidden');
            }
            pressedOnBackdrop = false;
        });
    }
}

// The two extra controls on the edit panel.
function setupEditModalExtras() {
    const clearBtn = document.getElementById('edit-enhanced-clear');
    if (clearBtn) {
        clearBtn.addEventListener('click', async () => {
            const box = document.getElementById('edit-enhanced-context');
            if (!box || !box.value.trim()) return;

            const confirmed = await CastConfirm.ask({
                title: 'Clear the enhanced profile?',
                message: 'The character will fall back to the short description until you build it again.',
                confirmText: 'Clear it',
                tone: 'warning',
            });
            if (!confirmed) return;

            box.value = '';
            const meta = document.getElementById('edit-enhanced-meta');
            if (meta) meta.textContent = 'Cleared, not saved yet';
        });
    }

    const cancelBtn = document.getElementById('cancel-edit-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            const modal = document.getElementById('edit-character-modal');
            if (modal) modal.classList.add('hidden');
        });
    }

    // A running count as you type, so it is obvious the box holds real content.
    const box = document.getElementById('edit-enhanced-context');
    const meta = document.getElementById('edit-enhanced-meta');
    if (box && meta) {
        box.addEventListener('input', () => {
            const length = box.value.trim().length;
            meta.textContent = length
                ? `${length.toLocaleString()} characters, not saved yet`
                : 'Empty, will fall back to the description';
        });
    }
}
