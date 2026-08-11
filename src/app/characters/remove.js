// Deleting a character, and everything that pointed at them.
//
// Deleting is asked about first, through src/confirm.js, and then has to be complete: the record,
// the picture, the chats, the saved history, the membership of any group chat, and the open chat if
// it was theirs. A half done delete is what leaves a chat that cannot be opened and cannot be
// removed, so the tidying up is written out in full rather than left to run later.

async function deleteCharacter(characterId) {
    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("That character could not be found.");
        return false;
    }

    // Work out what is actually about to be lost, so the question is specific
    // rather than a vague are you sure. Losing a character also loses every chat
    // with them, which was not obvious before.
    const affectedChats = Object.keys(state.chats).filter(chatId =>
        chatBelongsToCharacter(chatId, characterId)
    );
    let messageCount = 0;
    affectedChats.forEach(chatId => {
        const body = state.chats[chatId];
        if (Array.isArray(body)) messageCount += body.filter(m => m && !m.isDeleted).length;
    });

    const parts = [];
    if (affectedChats.length) {
        parts.push(`${affectedChats.length} ${affectedChats.length === 1 ? "chat" : "chats"}`);
    }
    if (messageCount) {
        parts.push(`${messageCount} ${messageCount === 1 ? "message" : "messages"}`);
    }

    const confirmed = await CastConfirm.ask({
        title: `Delete ${character.name}?`,
        message: parts.length
            ? `This also deletes ${parts.join(" and ")} with them. It cannot be undone.`
            : "This cannot be undone.",
        detail: parts.length ? "Save a backup first if you might want any of this back." : "",
        confirmText: "Delete",
        tone: "danger",
    });

    if (!confirmed) return false;

    recordActivity(CastLog.KINDS.CHARACTER_DELETED, `${character.name}, with ${affectedChats.length} of their chats`);
    return performCharacterDeletion(characterId);
}

// The actual removal, kept separate from the asking so the confirmation cannot
// accidentally be skipped by a future caller reaching for the wrong function.
function performCharacterDeletion(characterId) {
    console.log("Deleting character:", characterId);

    // Remove from characters array
    state.characters = state.characters.filter(c => c.id !== characterId);
    setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    // Remove from selected characters
    state.selectedCharacters = state.selectedCharacters.filter(id => id !== characterId);

    // Remove from active characters if present
    if (state.activeCharacters) {
        state.activeCharacters = state.activeCharacters.filter(c => c.id !== characterId);
    }

    // Remove from last active chats
    if (state.lastActiveChats[characterId]) {
        delete state.lastActiveChats[characterId];
        setStoredItem(STORAGE_KEYS.LAST_ACTIVE_CHATS, state.lastActiveChats);
    }

    // Remove associated chats.
    //
    // This used to ask whether the character's ID appeared anywhere inside the
    // chat ID as plain text. That is not the same question as whether the chat
    // belongs to the character, and it was being used to decide what to delete.
    // It now checks recorded membership instead.
    let chatsRemoved = 0;
    Object.keys(state.chats).forEach(chatId => {
        if (chatBelongsToCharacter(chatId, characterId)) {
            delete state.chats[chatId];
            delete state.chatMembers[chatId];
            if (state.chatMemory) delete state.chatMemory[chatId];
            chatsRemoved++;
        }
    });
    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    setStoredItem(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory || {});

    // Remove the picture too, so it is not left behind taking up space.
    CastImages.deletePicture(characterId).catch(() => {});
    delete state.pictureCache[characterId];

    console.log(`Character deleted, along with ${chatsRemoved} of their chats.`);

    // Remove the HTML element directly
    const charElement = document.getElementById(`character-item-${characterId}`);
    if (charElement) {
        charElement.remove();
    }

    // Optionally, update the sidebar if needed
    updateSidebarCharacters();

    // Show success message
    showSuccess("Character deleted.");

    // Comprehensive UI update
    updateCharacterLists();

    // Make sure we update the chat view too if needed
    if (state.activeChat && chatBelongsToCharacter(state.activeChat, characterId)) {
        // Reset active chat if it contained the deleted character
        state.activeChat = null;
        changeView('chat'); // Force refresh of chat view
    }

    return true;
}
