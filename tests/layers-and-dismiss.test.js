// The things that float above the page: what order they stack in, and what dismisses them.
//
// Both of these were real faults with the same shape. A modal was marked with a stacking number
// chosen on its own rather than against the rest of the app, so the header covered the top of it
// including the control to close it. And a modal was dismissed by any click that ended on its
// backdrop, so selecting text inside it and letting go outside threw away what you had typed.
//
// Neither can be seen by reading the file the modal is defined in, which is why they are checked here.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { bootApp, ROOT } = require('../tools/loadapp');

const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// The ladder, read out of the declarations rather than written down twice.
function ladder() {
    const block = css.slice(css.indexOf(':root {'), css.indexOf('/* Utility classes */'));
    const values = {};
    (block.match(/--z-[a-z-]+:\s*\d+/g) || []).forEach((entry) => {
        const [name, value] = entry.split(':');
        values[name.trim()] = Number(value.trim());
    });
    return values;
}

const Z = ladder();

test('there is a single stacking ladder, and everything is on it', () => {
    const expected = [
        '--z-content', '--z-chat-input', '--z-sidebar-scrim', '--z-sidebar',
        '--z-header', '--z-reminder', '--z-modal', '--z-modal-head', '--z-confirm', '--z-toast',
    ];
    expected.forEach((name) => {
        assert.ok(typeof Z[name] === 'number', `${name} is missing from the ladder`);
    });
});

test('a modal is above the header, which is the fault this fixes', () => {
    // The header is fixed to the top of the page. A modal below it has its heading, and the button
    // that closes it, hidden behind the header.
    assert.ok(Z['--z-modal'] > Z['--z-header'],
        `a modal at ${Z['--z-modal']} would sit under the header at ${Z['--z-header']}`);
});

test('a modal is above the message box, which covered it on a phone', () => {
    assert.ok(Z['--z-modal'] > Z['--z-chat-input'],
        'the message box is fixed to the bottom on a phone and would cover a modal');
});

test('the whole ladder is in a sensible order', () => {
    const order = [
        '--z-content', '--z-chat-input', '--z-sidebar-scrim', '--z-sidebar',
        '--z-header', '--z-reminder', '--z-modal', '--z-modal-head', '--z-confirm', '--z-toast',
    ];
    for (let i = 1; i < order.length; i += 1) {
        assert.ok(Z[order[i]] > Z[order[i - 1]],
            `${order[i]} (${Z[order[i]]}) should be above ${order[i - 1]} (${Z[order[i - 1]]})`);
    }
});

test('asking before a delete is answerable from inside a modal', () => {
    // Deleting a chat is offered from inside the chat history panel. If the question appears behind
    // the panel it cannot be answered, and the panel cannot be closed either.
    assert.ok(Z['--z-confirm'] > Z['--z-modal']);
    assert.ok(css.includes('#cast-confirm-overlay'), 'the confirm layer is not placed on the ladder');
});

test('notices are readable over everything, since they report on it', () => {
    Object.entries(Z).forEach(([name, value]) => {
        if (name === '--z-toast') return;
        assert.ok(Z['--z-toast'] > value, `a notice at ${Z['--z-toast']} would sit under ${name}`);
    });
});

test('no floating layer sets its own number in the markup', () => {
    // A utility class in the markup is how both modals ended up below the header: the number was
    // chosen next to the element rather than against the rest of the app.
    ['edit-character-modal', 'chat-history-modal'].forEach((id) => {
        const tag = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`, 's'));
        assert.ok(tag, `${id} is not in index.html`);
        assert.ok(!/\bz-\d+\b|\bz-\[\d+\]/.test(tag[0]),
            `${id} sets its own stacking number in the markup; it should come from the ladder`);
    });

    ['#edit-character-modal', '#chat-history-modal'].forEach((selector) => {
        assert.ok(css.includes(selector), `${selector} is not placed by the ladder in style.css`);
    });
});

// --- What dismisses a modal ------------------------------------------------------------------

// Opens the edit panel in a started app and hands back the pieces needed to poke at it.
async function withEditPanel() {
    const app = await bootApp();
    const document = app.win.document;
    const modal = document.getElementById('edit-character-modal');
    assert.ok(modal, 'the edit panel is not in index.html');

    modal.classList.remove('hidden');

    // Stands in for the box inside the backdrop. What matters to the handler is only whether an
    // event's target is the backdrop itself or something else, so this does not have to be the real
    // panel.
    const panel = document.createElement('div');

    // The test that a click outside does still close the panel is what proves the handler is
    // attached at all. Without it the tests below would pass because nothing was listening.
    return { app, document, modal, panel };
}

test('clicking the dark area outside closes the panel', async () => {
    const { modal } = await withEditPanel();

    modal.__fire('mousedown', { target: modal });
    modal.__fire('click', { target: modal });

    assert.ok(modal.classList.contains('hidden'), 'a plain click outside should still close it');
});

test('clicking inside the panel does not close it', async () => {
    const { modal, panel } = await withEditPanel();

    modal.__fire('mousedown', { target: panel });
    modal.__fire('click', { target: panel });

    assert.ok(!modal.classList.contains('hidden'));
});

test('selecting text inside the panel and letting go outside does not close it', async () => {
    // This is the fault. The press lands inside, the release lands on the backdrop, and the click
    // that follows reports the backdrop as its target. The old handler saw that and closed, which
    // threw away whatever had been typed.
    const { modal, panel } = await withEditPanel();

    modal.__fire('mousedown', { target: panel });
    modal.__fire('click', { target: modal });

    assert.ok(!modal.classList.contains('hidden'),
        'a drag that started inside the panel must not close it');
});

test('a drag that starts outside and ends outside does not close it either, while text is selected', async () => {
    const { app, modal } = await withEditPanel();

    // Something is selected, so this was a drag rather than a click.
    app.win.getSelection = () => ({ toString: () => 'some selected words' });

    modal.__fire('mousedown', { target: modal });
    modal.__fire('click', { target: modal });

    assert.ok(!modal.classList.contains('hidden'),
        'a release that completed a text selection is not a click away');
});

test('a touch that starts inside the panel does not close it', async () => {
    const { modal, panel } = await withEditPanel();

    modal.__fire('touchstart', { target: panel });
    modal.__fire('click', { target: modal });

    assert.ok(!modal.classList.contains('hidden'));
});

test('the confirm dialog follows the same rule', () => {
    // Same fault, same fix, in the module that asks before anything is deleted. Checked by reading
    // the source, because the dialog builds its own elements and only exists while it is open.
    const confirmSource = fs.readFileSync(path.join(ROOT, 'src', 'confirm.js'), 'utf8');

    assert.match(confirmSource, /addEventListener\("mousedown"/,
        'the confirm dialog should track where the press started');
    assert.match(confirmSource, /addEventListener\("touchstart"/,
        'and where a touch started');
    assert.match(confirmSource, /pressedOutside && releasedOutside/,
        'both the press and the release have to be outside for it to count as cancelling');
});
