// Finding a character, and putting them in an order.
//
// Search looks at names, descriptions and the messages themselves, which is the useful part and
// also the slow part, so the message results are cached until something changes. The characters
// page and the sidebar keep separate search terms: they used to share one, and typing in either box
// filtered both pages.
//
// filterCharacters and sortCharacters are plain functions over an array and are the easiest place
// in the app to add a new way of narrowing or ordering the list.

// Says when a search is hiding some of the list, with a way to clear it.
//
// Without this a filter is invisible: the list is short, nothing explains why, and it looks like
// data has gone missing. That is exactly how a shared search field turned into an alarming bug
// rather than a small annoyance.
function showFilterNotice(noticeId, container, term, showing, total, onClear) {
    const existing = document.getElementById(noticeId);
    if (existing) existing.remove();

    const trimmed = String(term || '').trim();
    if (!trimmed || !container || !container.parentNode) return;

    const notice = document.createElement('div');
    notice.id = noticeId;
    notice.className = 'filter-notice';
    notice.innerHTML = `
        <span>
            <i class="fas fa-filter"></i>
            Showing ${showing} of ${total}, filtered by "${CastEscape.escapeHtml(trimmed)}"
        </span>
        <button type="button">Clear search</button>
    `;
    notice.querySelector('button').addEventListener('click', onClear);
    container.parentNode.insertBefore(notice, container);
}

function clearCharacterSearch() {
    state.characterSearchTerm = '';
    const input = document.getElementById('search-characters-input');
    if (input) input.value = '';
    renderFilteredAndSortedCharacters();
}

function clearSidebarSearch() {
    state.sidebarSearchTerm = '';
    const input = document.getElementById('sidebar-search');
    if (input) input.value = '';
    updateSidebarCharacters();
}

function setupSearchBoxes() {
    const homeSearch = document.getElementById('home-search');
    if (homeSearch) {
        homeSearch.addEventListener('input', debounce(() => renderChatHome(homeSearch.value), 120));
    }

    const sidebarSearch = document.getElementById('sidebar-search');
    if (sidebarSearch) {
        sidebarSearch.addEventListener('input', debounce(() => {
            state.sidebarSearchTerm = sidebarSearch.value;
            updateSidebarCharacters();
        }, 120));
    }
}


function filterCharacters(characters, searchTerm) {
    if (!searchTerm || String(searchTerm).trim() === "") {
        return characters;
    }
    const term = String(searchTerm).trim().toLowerCase();
    const list = Array.isArray(characters) ? characters : [];

    return list.filter(character => {
        if (!character) return false;

        const name = String(character.name || '').toLowerCase();
        const described = String(character.userContext || '').toLowerCase();
        const enhanced = String(character.enhancedContext || '').toLowerCase();

        if (name.includes(term) || described.includes(term) || enhanced.includes(term)) {
            return true;
        }

        // And inside the conversations, so a half remembered line is enough to find someone.
        return chatContainsText(character.id, term);
    });
}

// Does any message in any chat with this character contain this text?
//
// Cached per search term, because the filter runs on every keystroke and walking every message
// of every chat each time would make typing feel sticky. The cache is dropped whenever a
// message is added or removed.
let chatSearchCache = { term: null, matches: null };

function chatContainsText(characterId, term) {
    if (!characterId || !term) return false;

    if (chatSearchCache.term !== term) {
        chatSearchCache = { term, matches: new Set() };

        Object.keys(state.chats || {}).forEach(chatId => {
            const body = state.chats[chatId];
            if (!Array.isArray(body)) return;

            const hit = body.some(message =>
                message
                && !message.isDeleted
                && typeof message.content === 'string'
                && message.content.toLowerCase().includes(term)
            );

            if (hit) {
                getChatCharacterIds(chatId).forEach(id => chatSearchCache.matches.add(id));
            }
        });
    }

    return chatSearchCache.matches.has(characterId);
}

// Called whenever the conversations change, so a search cannot show a stale result.
function clearChatSearchCache() {
    chatSearchCache = { term: null, matches: null };
}

function sortCharacters(characters, sortOrder) {
    const sorted = [...characters]; // Create a new array to avoid mutating the original
    switch (sortOrder) {
        case "createdAt_desc":
            sorted.sort((a, b) => (b.createdAt ? new Date(b.createdAt).getTime() : 0) - (a.createdAt ? new Date(a.createdAt).getTime() : 0));
            break;
        case "createdAt_asc":
            sorted.sort((a, b) => (a.createdAt ? new Date(a.createdAt).getTime() : 0) - (b.createdAt ? new Date(b.createdAt).getTime() : 0));
            break;
        case "name_asc":
            sorted.sort((a, b) => a.name.localeCompare(b.name));
            break;
        case "name_desc":
            sorted.sort((a, b) => b.name.localeCompare(a.name));
            break;
        case "lastChat_desc":
            sorted.sort((a, b) => {
                const tsA = getLastMessageTimestamp(a.id);
                const tsB = getLastMessageTimestamp(b.id);
                if (tsA === 0 && tsB !== 0) return 1; // Characters with no chats go to the end
                if (tsA !== 0 && tsB === 0) return -1; // Characters with chats come first
                return tsB - tsA; // Sort by most recent message
            });
            break;
    }
    return sorted;
}
