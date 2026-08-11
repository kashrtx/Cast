// Light, dark, and how wide the chat runs.
//
// Two small choices that both work the same way: read what was chosen, fall back to what the device
// prefers, apply it to the page, and remember it. Kept together because they are the only two
// settings that change how the app looks rather than what it does.

// Search, on both the home screen and the list beside a chat.
// Light or dark.
//
// Three settings rather than two, because following the device is what most people want and a fixed
// choice is what the rest want. The class is put on the html element by a small script in the page
// head as well, before anything is drawn, so the light theme never flashes before the dark one
// arrives.
function getTheme() {
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const ui = stored.value || {};
    return ['auto', 'light', 'dark'].includes(ui.theme) ? ui.theme : 'auto';
}

function prefersDarkDevice() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(theme) {
    const chosen = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
    const dark = chosen === 'dark' || (chosen === 'auto' && prefersDarkDevice());
    document.documentElement.classList.toggle('dark', dark);
    return chosen;
}

function setupThemeChoice() {
    const current = getTheme();
    applyTheme(current);

    const select = document.getElementById('theme-select');
    if (select) {
        select.value = current;
        select.addEventListener('change', () => {
            const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
            const ui = Object.assign({}, stored.value || {}, { theme: select.value });
            castStore.write(CastStorage.KEYS.UI_STATE, ui);
            applyTheme(select.value);
        });
    }

    // Follow the device as it changes, which matters for anyone whose system switches at sunset.
    if (window.matchMedia) {
        const query = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => { if (getTheme() === 'auto') applyTheme('auto'); };
        if (query.addEventListener) query.addEventListener('change', onChange);
        else if (query.addListener) query.addListener(onChange);
    }
}

// Which chat layout is in use.
//
// Modern is the board of characters. Classic is the list down the side, kept because it is
// what the app has always looked like and some people will prefer it.
function getChatLayout() {
    const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
    const ui = stored.value || {};
    return ui.chatLayout === 'classic' ? 'classic' : 'modern';
}

function applyChatLayout(mode) {
    const layout = mode === 'classic' ? 'classic' : 'modern';
    // Kept on both, because the class is put on the html element before the page is drawn
    // to avoid a flash, and the rest of the app reads it from the body.
    [document.documentElement, document.body].forEach(function (element) {
        element.classList.toggle('layout-classic', layout === 'classic');
        element.classList.toggle('layout-modern', layout === 'modern');
    });

    // The classic list can be hidden. The modern board is the navigation, so hiding it
    // would leave nothing to navigate with.
    if (layout === 'modern') {
        document.body.classList.remove('sidebar-hidden');
    }

    return layout;
}

function setupChatLayoutChoice() {
    const current = getChatLayout();
    applyChatLayout(current);

    document.querySelectorAll('input[name="chat-layout"]').forEach(radio => {
        radio.checked = radio.value === current;
        radio.addEventListener('change', () => {
            if (!radio.checked) return;

            const stored = castStore.read(CastStorage.KEYS.UI_STATE, "object");
            const ui = Object.assign({}, stored.value || {}, { chatLayout: radio.value });
            castStore.write(CastStorage.KEYS.UI_STATE, ui);

            applyChatLayout(radio.value);
            renderChatHome('');
            updateSidebarCharacters();

            notify(radio.value === 'modern'
                ? 'Using the modern board.'
                : 'Using the classic list.', 'success');
        });
    });
}
