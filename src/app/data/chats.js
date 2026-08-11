// Which characters a chat belongs to.
//
// Chat IDs used to have the character IDs glued into them, and the app worked out membership by
// splitting the string back up. That is what once filed chats under keys that were part ID and part
// timestamp. IDs are now opaque and membership is real data on the chat.
//
// getLiveCharacter is the other thing here and matters more than it looks: it re-reads a character
// from state rather than trusting a copy taken earlier, which is what makes an edit apply to the
// very next message instead of the next time the chat is opened.

// Records which characters each chat belongs to, as real data on the chat rather
// than something to be guessed from the shape of the chat ID later.
function ensureChatMembership() {
    if (!state.chatMembers || typeof state.chatMembers !== "object") {
        state.chatMembers = {};
    }

    const knownIds = new Set((state.characters || []).map(c => c && c.id).filter(Boolean));
    let changed = false;

    // Anything already recorded is trusted. For the rest, fall back to reading
    // the old style ID, keeping only the parts that are genuinely character IDs.
    Object.keys(state.chats || {}).forEach(chatId => {
        if (Array.isArray(state.chatMembers[chatId]) && state.chatMembers[chatId].length) return;

        const parts = String(chatId).replace(/^chat_/, "").split("-");
        const members = parts.filter(part => knownIds.has(part));

        if (members.length) {
            state.chatMembers[chatId] = members;
            changed = true;
        }
    });

    // Repair the grouping of any history still filed under a key with a
    // timestamp glued onto it.
    const needsRepair = Object.keys(state.chatHistory || {}).some(key => /-\d{10,}/.test(key));
    if (needsRepair) {
        const repaired = CastBackup.repairHistoryGrouping(state.chatHistory, state.characters);
        state.chatHistory = repaired.chatHistory;
        Object.keys(repaired.chatMembers).forEach(chatId => {
            if (!state.chatMembers[chatId] || !state.chatMembers[chatId].length) {
                state.chatMembers[chatId] = repaired.chatMembers[chatId];
            }
        });
        changed = true;
        console.log(`Regrouped ${repaired.movedGroups} chat history groups that were filed under the wrong key.`);
        setStoredItem(STORAGE_KEYS.CHAT_HISTORY, state.chatHistory);
    }

    if (changed) {
        setStoredItem(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
    }
}

// The one true copy of a character.
//
// state.characters holds the real records. Everywhere else that holds a character,
// such as state.activeCharacters, should be treated as a hint about which character
// rather than as the character itself, because those can fall behind after an edit.
//
// Anything that reads a description or writes to a character should go through here
// first, so an edit made a moment ago is always the version that gets used.
function getLiveCharacter(idOrCharacter) {
    if (!idOrCharacter) return null;
    const id = typeof idOrCharacter === "string" ? idOrCharacter : idOrCharacter.id;
    if (!id) return null;
    const live = (state.characters || []).find(c => c && c.id === id);
    // If the record has genuinely gone, fall back to whatever was handed in rather
    // than returning nothing, so a reply in flight can still finish.
    return live || (typeof idOrCharacter === "object" ? idOrCharacter : null);
}

// Returns the characters taking part in a chat, using recorded membership rather
// than checking whether one ID happens to appear inside another as text.
//
// When membership has not been recorded yet, it is worked out from the ID and then
// remembered. Chats are created in several places, and having this one function
// record what it derives means every one of them ends up with proper membership
// without each having to remember to do it.
function getChatCharacterIds(chatId) {
    if (!chatId) return [];

    const recorded = state.chatMembers && state.chatMembers[chatId];
    if (Array.isArray(recorded) && recorded.length) return recorded.slice();

    // Only ever keep parts that match a character that actually exists, which is
    // what stops a timestamp being mistaken for a character.
    const knownIds = new Set((state.characters || []).map(c => c && c.id).filter(Boolean));
    const derived = String(chatId).replace(/^chat_/, "").split("-").filter(part => knownIds.has(part));

    if (derived.length) {
        if (!state.chatMembers) state.chatMembers = {};
        state.chatMembers[chatId] = derived;
        // Saved on a short delay so creating several chats at once does not write
        // repeatedly.
        if (state.membershipSaveTimer) clearTimeout(state.membershipSaveTimer);
        state.membershipSaveTimer = setTimeout(() => {
            castStore.write(CastStorage.KEYS.CHAT_MEMBERS, state.chatMembers);
        }, 1000);
    }

    return derived;
}

function chatBelongsToCharacter(chatId, characterId) {
    return getChatCharacterIds(chatId).indexOf(characterId) !== -1;
}

function getChatCharacters(chatId) {
    const ids = getChatCharacterIds(chatId);
    return (state.characters || []).filter(c => c && ids.indexOf(c.id) !== -1);
}
