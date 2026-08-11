// The first screen: carry on with something, or start something new.
//
// Recent chats come first because that is nearly always what was wanted, then everyone else. The
// cards are built here.

// The home screen, shown when no chat is open.
//
// It used to be one line of grey text saying to pick someone. This shows who you have,
// what you last said to each other, and how much history there is, with the conversations
// you are part way through pulled to the front.
function renderChatHome(searchTerm) {
    const home = document.getElementById('chat-home');
    if (!home) return;

    const term = typeof searchTerm === 'string'
        ? searchTerm
        : (document.getElementById('home-search') || {}).value || '';

    const all = filterCharacters(state.characters || [], term);

    const countLabel = document.getElementById('home-count');
    if (countLabel) {
        const total = (state.characters || []).length;
        countLabel.textContent = term.trim()
            ? `${all.length} of ${total}`
            : `${total} ${total === 1 ? 'character' : 'characters'}`;
    }

    const providerLine = document.getElementById('home-provider');
    if (providerLine) {
        providerLine.textContent = `${getProviderDisplayName()}, ${getModelFor()}`;
    }

    const empty = document.getElementById('home-empty');
    const allSection = document.getElementById('home-all-section');
    const recentSection = document.getElementById('home-recent-section');

    if (!all.length) {
        if (empty) {
            empty.classList.remove('hidden');
            const message = empty.querySelector('p');
            if (message) {
                message.textContent = term.trim()
                    ? `Nobody matches "${term.trim()}".`
                    : 'No characters yet.';
            }
        }
        if (allSection) allSection.classList.add('hidden');
        if (recentSection) recentSection.classList.add('hidden');
        return;
    }

    if (empty) empty.classList.add('hidden');
    if (allSection) allSection.classList.remove('hidden');

    // Anyone with a conversation already going, most recent first.
    const withHistory = all
        .map(character => ({ character, at: getLastMessageTimestamp(character.id) }))
        .filter(entry => entry.at > 0)
        .sort((a, b) => b.at - a.at)
        .slice(0, 4);

    const recent = document.getElementById('home-recent');
    if (recentSection && recent) {
        if (withHistory.length && !term.trim()) {
            recentSection.classList.remove('hidden');
            recent.innerHTML = withHistory.map(entry => homeCard(entry.character, true)).join('');
        } else {
            recentSection.classList.add('hidden');
        }
    }

    const list = document.getElementById('home-all');
    if (list) {
        // Anyone already shown above is left out here, otherwise the same four appear twice
        // and it reads as though they are duplicated.
        const shownAbove = new Set(
            (recentSection && !recentSection.classList.contains('hidden'))
                ? withHistory.map(entry => entry.character.id)
                : []
        );
        const rest = all.filter(character => !shownAbove.has(character.id));

        const heading = document.querySelector('#home-all-section h3');
        if (heading) heading.textContent = shownAbove.size ? 'Everyone else' : 'Everyone';

        list.innerHTML = rest.map(character => homeCard(character, false)).join('');
        if (!rest.length) document.getElementById('home-all-section').classList.add('hidden');
        else document.getElementById('home-all-section').classList.remove('hidden');
    }

    // One handler for the whole grid rather than one per card.
    home.querySelectorAll('[data-open-character]').forEach(card => {
        card.addEventListener('click', () => {
            const id = card.getAttribute('data-open-character');
            if (!id) return;
            state.selectedCharacters = [id];
            toggleCharacterSelection(id);
        });
    });
}

// One card on the home screen.
function homeCard(character, isRecent) {
    const safeName = CastEscape.escapeHtml(character.name);
    const picture = CastEscape.safeImageUrl(getCharacterPicture(character));

    const avatar = picture
        ? `<img src="${picture}" alt="${safeName}" loading="lazy" class="w-11 h-11 rounded-full object-cover flex-shrink-0">`
        : `<div class="w-11 h-11 rounded-full bg-primary/15 text-primary flex items-center justify-center font-semibold flex-shrink-0">${CastEscape.initial(character.name)}</div>`;

    // How much has been said, and the last thing said.
    let messageCount = 0;
    let lastLine = '';
    Object.keys(state.chats || {}).forEach(chatId => {
        if (!chatBelongsToCharacter(chatId, character.id)) return;
        const body = state.chats[chatId];
        if (!Array.isArray(body)) return;
        body.forEach(message => {
            if (!message || message.isDeleted || message.isSystem || message.isTyping) return;
            messageCount += 1;
            if (typeof message.content === 'string' && message.content.trim()) {
                lastLine = message.content;
            }
        });
    });

    const preview = lastLine
        ? CastEscape.escapeHtml(lastLine.replace(/[*_#>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90))
        : CastEscape.escapeHtml(String(character.userContext || '').replace(/\s+/g, ' ').trim().slice(0, 90));

    const when = getLastMessageTimestamp(character.id);
    const meta = messageCount
        ? `${messageCount} ${messageCount === 1 ? 'message' : 'messages'}${when ? ` &middot; ${CastEscape.escapeHtml(formatDateTime(when))}` : ''}`
        : 'No messages yet';

    return `
        <button type="button" data-open-character="${CastEscape.escapeAttribute(character.id)}"
            class="text-left w-full bg-white border rounded-xl p-4 hover:shadow-md hover:border-primary/40 transition flex gap-3 items-start${isRecent ? ' border-primary/30' : ''}">
            ${avatar}
            <div class="min-w-0 flex-grow">
                <p class="font-semibold text-gray-800 truncate">${safeName}</p>
                <p class="text-sm text-gray-500 truncate">${preview || 'No description yet'}</p>
                <p class="text-xs text-gray-400 mt-1">${meta}</p>
            </div>
        </button>`;
}
