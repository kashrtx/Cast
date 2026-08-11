// Connecting the controls on the page to the code that runs.
//
// Nearly every listener in the app is attached from here, in one pass at start up. Having one place
// for it is what stops the same button being wired twice, which is the fault behind a message sent
// two at a time.
//
// If you add a control to index.html, this is where it is connected.

// Set up direct click handlers that don't rely on generated HTML
function setupDirectListeners() {
    // Menu buttons
    document.querySelectorAll('[id$="-btn"]').forEach(button => {
        if (button.id === 'chat-btn') {
            button.addEventListener('click', () => changeView('chat'));
        } else if (button.id === 'characters-btn') {
            button.addEventListener('click', () => changeView('characters'));
        } else if (button.id === 'settings-btn') {
            button.addEventListener('click', () => changeView('settings'));
        } else if (button.id === 'test-chat-btn') {
            button.addEventListener('click', () => forceOpenChat());
        }
    });

    // Character create button
    const createCharBtn = document.getElementById('create-character-btn');
    if (createCharBtn) {
        createCharBtn.addEventListener('click', createNewCharacter);
    }

    // Error dismiss button
    // The error banner this used to wire up has been replaced by notifications, which build
    // and remove their own controls.
}

// Set up event listeners
function setupEventListeners() {
    // Chat form submission
    const chatForm = document.getElementById('chat-form');
    const messageInput = document.getElementById('message-input');

    if (chatForm && messageInput) {
        // Handle form submission - updated to include button state update
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            // Call sendMessage which will update the button state
            sendMessage();
        });

        // Handle message input keydown.
        //
        // The decision itself lives in src/input.js so it can be tested. Enter sends,
        // Shift with Enter makes a new line. It used to be that Enter sent only when
        // there was text in the box, and did nothing at all when the box was empty,
        // so Enter inserted a newline in that one case. The placeholder also said
        // "Enter for new line", which was the opposite of what the code did.
        messageInput.addEventListener('keydown', (e) => {
            const action = CastInput.decideKeyAction({
                key: e.key,
                shiftKey: e.shiftKey,
                ctrlKey: e.ctrlKey,
                metaKey: e.metaKey,
                altKey: e.altKey,
                // Set while an input method is composing characters, for example when
                // typing Japanese. Enter confirms the composition there.
                isComposing: e.isComposing || e.keyCode === 229,
                value: messageInput.value,
                responseInProgress: state.isResponseInProgress,
            });

            if (action === 'pass-through') return;

            e.preventDefault();

            if (action === 'newline') {
                const result = CastInput.insertNewline(
                    messageInput.value,
                    messageInput.selectionStart,
                    messageInput.selectionEnd
                );
                messageInput.value = result.value;
                messageInput.selectionStart = messageInput.selectionEnd = result.cursor;
                // Let the box grow to fit the new line.
                messageInput.dispatchEvent(new Event('input'));
                return;
            }

            if (action === 'send') {
                sendMessage();
            }

            // "ignore" falls through, which is the point: nothing happens while a
            // reply is still arriving.
        });

        // Auto-resize input height based on content
        messageInput.addEventListener('input', () => {
            requestAnimationFrame(() => {
                messageInput.style.height = 'auto';
                const newScrollHeight = messageInput.scrollHeight; // Read
                messageInput.style.height = newScrollHeight + 'px'; // Write
            });
        });
    }

    // Make sidebar character items clickable
    updateSidebarCharacterListeners();

    // Save API Key button
    const saveButton = null /* the save control is inside the key row now */;
    if (saveButton) {
        saveButton.addEventListener('click', saveApiKey);
    } else {
        // If no save button, implement API key input event listener
        const apiKeyInput = document.getElementById('api-key-input');
        if (apiKeyInput) {
            apiKeyInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    saveApiKey();
                }
            });
        }
    }

    // Handle window resize for mobile/desktop detection
    window.addEventListener('resize', debounce(() => {
        initMessageDeleteButtons();
    }, 250));

    // The create character button is wired in setupEventListeners, which is the one place listeners
    // are attached. It used to be wired here as well, so createNewCharacter ran twice on every click:
    // the first call made the character and cleared the form, and the second then found an empty form
    // and complained. You got "Character created successfully" and "Please provide a name for your
    // character" at the same time, which reads like the save failed when it had worked.

    // Setup edit character modal
    setupEditCharacterModal();

    // Setup character selection in sidebar
    updateSidebarCharacterListeners();

    // Chat history and new chat buttons
    const newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) {
        newChatBtn.addEventListener('click', createNewChat);
    }

    const chatHistoryBtn = document.getElementById('chat-history-btn');
    if (chatHistoryBtn) {
        chatHistoryBtn.addEventListener('click', showChatHistory);
    }

    const closeHistoryModalBtn = document.getElementById('close-history-modal-btn');
    if (closeHistoryModalBtn) {
        closeHistoryModalBtn.addEventListener('click', closeChatHistoryModal);
    }

    const closeHistoryBtn = document.getElementById('close-history-btn');
    if (closeHistoryBtn) {
        closeHistoryBtn.addEventListener('click', closeChatHistoryModal);
    }

    // Setup data export and import buttons
    const exportDataBtn = document.getElementById('export-data-btn');
    const importDataBtn = document.getElementById('import-data-btn');

    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', exportAppData);
    }

    if (importDataBtn) {
        importDataBtn.addEventListener('click', importAppData);
    }

    // Setup profile picture handlers
    setupProfilePictureHandlers();

    // Setup focus handling for mobile
    setupFocusHandling();

    // Event listener for character search
    const searchInput = document.getElementById('search-characters-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            state.characterSearchTerm = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }

    // Event listener for character sort
    const sortSelect = document.getElementById('sort-characters-select');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            state.characterSortOrder = e.target.value;
            renderFilteredAndSortedCharacters();
        });
    }
}
