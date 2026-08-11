// The character list down the side, and whether it is showing.
//
// On a wide screen it sits open beside the chat. On a phone it slides over the top and has to be
// dismissed. Both use the same list, drawn here, which is also the fastest way to start a chat and
// so gets the picture, the last message and the selection state.

// Hiding the character list on a wide screen, and remembering that you hid it.
//
// Only affects desktop. On a phone the list is the main screen and tapping a name opens
// the chat, which works well, so nothing there changes.
function setupSidebarCollapse() {
    const hideBtn = document.getElementById('hide-sidebar-btn');
    const revealBtn = document.getElementById('reveal-sidebar-btn');

    const apply = (hidden) => {
        document.body.classList.toggle('sidebar-hidden', hidden);
    };

    // Restored before anything is drawn, so it does not flash open and then close.
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const uiState = stored.value || {};
    apply(Boolean(uiState.sidebarHidden));

    const remember = (hidden) => {
        const next = Object.assign({}, uiState, { sidebarHidden: hidden });
        castStore.write(CastStorage.KEYS.UI_STATE, next);
        uiState.sidebarHidden = hidden;
    };

    if (hideBtn) {
        hideBtn.addEventListener('click', () => { apply(true); remember(true); });
    }
    const revealMain = document.getElementById('reveal-sidebar-main');

    const homeBtn = document.getElementById('back-to-home-btn');
    if (homeBtn) homeBtn.addEventListener('click', returnToHome);

    [revealBtn, revealMain].forEach(button => {
        if (!button) return;
        button.addEventListener('click', () => { apply(false); remember(false); });
    });
}

// Initialize sidebar functionality
function initializeSidebar() {
    const sidebar = document.getElementById('character-sidebar');
    const toggleBtn = document.getElementById('toggle-sidebar-btn');
    const showCharactersBtn = document.getElementById('show-characters-btn');
    const showChatSidebarBtn = document.getElementById('show-chat-sidebar-btn');
    const chatView = document.getElementById('chat-view');
    const header = document.querySelector('header');

    // Create overlay element
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);

    // Toggle sidebar function
    function toggleSidebar() {
        sidebar.classList.toggle('sidebar-open');

        // Only use overlay on non-mobile devices
        if (window.innerWidth > 768) {
            overlay.classList.toggle('active');
        }

        // This used to set an inline overflow of hidden on the body while the list was
        // open, and clear it when closed. An inline style beats the stylesheet, and the
        // list can be closed by other routes that never run this function, so the lock
        // stayed on and scrolling was dead on every page until the list was opened and
        // closed again. That is the scroll break that kept coming back.
        //
        // Whether the page scrolls is decided by the stylesheet, from the current view.
        if (!sidebar.classList.contains('sidebar-open')) {
            // Small delay to ensure overlay is fully hidden before allowing interaction
            if (window.innerWidth > 768) {
                setTimeout(() => {
                    if (!sidebar.classList.contains('sidebar-open')) {
                        overlay.style.display = 'none';
                        setTimeout(() => {
                            overlay.style.display = '';
                        }, 50);
                    }
                }, 300); // Match the transition duration
            }
        }
    }

    // Function to adjust sidebar position based on header height
    function adjustSidebarPosition() {
        if (window.innerWidth < 1024) {
            const headerHeight = header.offsetHeight;
            sidebar.style.top = `${headerHeight}px`;

            // Update main content padding to account for fixed header
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = `${headerHeight}px`;
            }

            // Update height and max-height to ensure proper scrolling
            sidebar.style.height = `calc(100vh - ${headerHeight}px)`;
            sidebar.style.maxHeight = `calc(100vh - ${headerHeight}px)`;
        } else {
            sidebar.style.top = '';
            sidebar.style.height = '';
            sidebar.style.maxHeight = '';

            // Reset main padding for desktop
            const main = document.querySelector('main');
            if (main) {
                main.style.paddingTop = '';
            }
        }
    }

    // Call initially to set the correct position
    adjustSidebarPosition();

    // Add click events for all toggle buttons
    if (toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showCharactersBtn) {
        showCharactersBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    if (showChatSidebarBtn) {
        showChatSidebarBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent event bubbling
            toggleSidebar();
        });
    }

    overlay.addEventListener('click', toggleSidebar);

    // Close sidebar on chat start in mobile view
    const originalStartChat = startChat;
    startChat = function () {
        originalStartChat();
        if (window.innerWidth < 1024) { // lg breakpoint
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
            chatView.classList.add('chat-active');
        }
    };

    // Handle scroll events to ensure sidebar stays fixed
    window.addEventListener('scroll', () => {
        if (window.innerWidth < 1024) {
            // No need to reposition on scroll since it's fixed in CSS
            // But we can add this as a hook for any future scroll-based adjustments
        }
    });

    // Handle resize events
    window.addEventListener('resize', () => {
        if (window.innerWidth >= 1024) {
            sidebar.classList.remove('sidebar-open');
            if (window.innerWidth > 768) { // Only manage overlay on non-mobile
                overlay.classList.remove('active');
            }
        }
        adjustSidebarPosition();
    });
}

// Update sidebar character event listeners
function updateSidebarCharacterListeners() {
    console.log("Updating sidebar character listeners"); // Debug log

    // This ensures characters are clickable even if onclick attribute doesn't work
    state.characters.forEach(character => {
        const element = document.getElementById(`sidebar-char-${character.id}`);
        if (element) {
            // Remove old event listener to avoid duplicates
            const newElement = element.cloneNode(true);
            element.parentNode.replaceChild(newElement, element);

            // Add fresh event listener
            newElement.addEventListener('click', function (event) {
                event.preventDefault();
                console.log("Character clicked via event listener:", character.id);
                toggleCharacterSelection(character.id);
            });
        } else {
            console.warn(`Sidebar character element for ${character.id} not found`);
        }
    });

    // Also make sure the Start Chat button has its event listener
    // removed it
}

// Function to update just the sidebar character list
function updateSidebarCharacters() {
    // The home screen shows the same information, so it is refreshed alongside.
    if (typeof renderChatHome === 'function') {
        try { renderChatHome(); } catch (error) { console.warn('Home screen could not be drawn:', error); }
    }
    const sidebarCharactersContainer = document.getElementById('sidebar-characters');

    if (!sidebarCharactersContainer) {
        console.error("Sidebar characters container not found");
        return;
    }

    try {
        if (state.characters.length === 0) {
            sidebarCharactersContainer.innerHTML = `
                <p class="text-gray-500 italic p-4 text-sm">
                    No characters created yet. Go to Characters tab to create some.
                </p>
            `;
        } else {
            // Only the ones matching what you typed.
            const visibleCharacters = filterCharacters(state.characters, state.sidebarSearchTerm);

            showFilterNotice(
                'sidebar-filter-notice',
                sidebarCharactersContainer,
                state.sidebarSearchTerm,
                visibleCharacters.length,
                state.characters.length,
                clearSidebarSearch
            );

            if (!visibleCharacters.length) {
                sidebarCharactersContainer.innerHTML = `
                    <p class="text-gray-500 italic p-4 text-sm">
                        Nobody matches that search.
                        <button type="button" class="text-primary underline not-italic" onclick="clearSidebarSearch()">Clear it</button>
                    </p>
                `;
                return;
            }

            // Sorted by when you last talked to someone.
            //
            // There used to be a rule here putting whoever was selected at the top. That was
            // the other half of the reordering complaint: even after the timestamp was fixed,
            // opening a character still moved them, because this rule moved them separately.
            // The order now only reflects real conversation activity.
            const sortedCharacters = [...visibleCharacters].sort((a, b) => {
                const aTimestamp = getLastMessageTimestamp(a.id);
                const bTimestamp = getLastMessageTimestamp(b.id);

                // Ensure createdAt is valid, default to 0 if not (for very old data potentially)
                const aCreationTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bCreationTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;

                // Rule 1: If one character has chats (timestamp > 0) and the other doesn't (timestamp == 0),
                // the one without chats (potentially newer) comes first (return -1 for a, 1 for b).
                if (aTimestamp === 0 && bTimestamp !== 0) return -1;
                if (aTimestamp !== 0 && bTimestamp === 0) return 1;

                // Rule 2: If both characters have no chats (both timestamps are 0),
                // sort by most recent creation time (descending order, so newer characters first).
                if (aTimestamp === 0 && bTimestamp === 0) {
                    return bCreationTime - aCreationTime;
                }

                // Rule 3: If both characters have chats (both timestamps > 0),
                // sort by most recent message timestamp (descending order).
                return bTimestamp - aTimestamp;
            });

            const sidebarHTML = sortedCharacters.map(character => {
                const lastMessageTime = getLastMessageTimestamp(character.id);
                const hasRecentChat = lastMessageTime > 0;
                const isActive = state.activeCharacters && state.activeCharacters.some(c => c.id === character.id);

                // Format date with time
                const formatDateTime = (timestamp) => {
                    const date = new Date(timestamp);
                    return date.toLocaleString(undefined, {
                        month: '2-digit',
                        day: '2-digit',
                        year: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: true
                    });
                };

                // This is the list you see on a phone, so it matters that it is
                // both safe and quick to draw.
                const safeName = CastEscape.escapeHtml(character.name);
                const picture = CastEscape.safeImageUrl(getCharacterPicture(character));

                let avatarHTML = '';
                let avatarClass = '';
                if (picture) {
                    avatarHTML = `<img src="${picture}" alt="${safeName}" loading="lazy" class="w-full h-full object-cover">`;
                    avatarClass = 'has-image';
                } else {
                    avatarHTML = CastEscape.initial(character.name);
                    avatarClass = '';
                }

                return `
                <div 
                    id="sidebar-char-${character.id}"
                    data-character-id="${character.id}"
                    class="p-3 rounded mb-2 cursor-pointer character-item ${state.selectedCharacters.includes(character.id)
                        ? 'bg-primary/10 border-primary/30 border'
                        : 'hover:bg-gray-100 border border-transparent'
                    } ${isActive ? 'border-primary' : ''}"
                >
                    <div class="flex items-center justify-between">
                        <div class="flex items-center">
                            <div class="character-avatar bg-primary/20 text-primary ${avatarClass}">
                                ${avatarHTML}
                            </div>
                            <div class="ml-2 overflow-hidden">
                                <p class="font-medium truncate">${safeName}</p>
                                ${hasRecentChat ? `
                                <p class="text-xs text-gray-500">
                                    Last chat: ${isActive ? 'Active now' : formatDateTime(lastMessageTime)}
                                </p>` : ''}
                            </div>
                        </div>
                        
                        <div class="w-2 h-2 rounded-full ${isActive ? 'bg-primary' : 'bg-primary/50'}"></div>
                    </div>
                </div>
            `}).join('');

            // Use innerHTML for the sidebar update
            sidebarCharactersContainer.innerHTML = sidebarHTML;
        }

        // Setup event listeners for the sidebar characters
        setupSidebarCharacterListeners();

    } catch (error) {
        console.error("Error updating sidebar characters:", error);
    }
}

// Function to setup sidebar character listeners
function setupSidebarCharacterListeners() {
    console.log("Setting up sidebar character listeners");

    document.querySelectorAll('[id^="sidebar-char-"]').forEach(element => {
        const characterId = element.getAttribute('data-character-id');
        if (!characterId) {
            console.warn("Character element without data-character-id:", element);
            return;
        }

        // Remove any existing event listeners by cloning and replacing
        const newElement = element.cloneNode(true);
        element.parentNode.replaceChild(newElement, element);

        // Add fresh event listener using the data attribute
        newElement.addEventListener('click', function (e) {
            e.preventDefault();
            console.log("Character clicked in sidebar:", characterId);
            toggleCharacterSelection(characterId);
        });
    });

    // Also set up the Start Chat button
    // removed it
}
