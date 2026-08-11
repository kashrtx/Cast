// Dark mode, checked rather than eyeballed.
//
// Dark mode was added one panel at a time, which meant that a colour used somewhere nobody had looked
// at yet stayed light. The tinted result panels in Settings were pastel on a dark page, and the close
// control on the chat history panel was dark grey on dark grey, which is a control you cannot see.
//
// This walks the markup and every file that builds markup, collects every colour class in use, and
// requires each one either to have a rule under html.dark or to be named below as a colour that is
// right in both modes. Adding a colour to the app and forgetting dark mode fails here.
//
// It checks that a rule exists, not that the result looks good. Whether a shade is the right shade
// still needs eyes on a screen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// Colours that are correct without a dark rule. Each one needs a reason, so that this list stays a
// set of decisions rather than somewhere to put anything that fails.
const CORRECT_IN_BOTH_MODES = {
    'bg-black': 'the dark area behind a modal, which is dark in both modes by design',
    'text-white': 'sits on a solid coloured button, which keeps its colour in dark mode',
    'border-red-500': 'marks a field that failed validation, and reads correctly on either background',
};

// Classes that set a colour, as opposed to a size or a position.
const COLOUR_CLASS = new RegExp(
    '\\b(bg|text|border|divide|placeholder|ring)-'
    + '(white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|green|emerald|teal|cyan'
    + '|sky|blue|indigo|violet|purple|fuchsia|pink|rose)'
    + '(-\\d{2,3})?\\b',
    'g'
);

function filesThatProduceMarkup() {
    const found = [path.join(ROOT, 'index.html')];
    const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) found.push(full);
        });
    };
    walk(path.join(ROOT, 'src', 'app'));
    return found;
}

// Every colour class in use, and which files use it.
function coloursInUse() {
    const used = new Map();
    filesThatProduceMarkup().forEach((file) => {
        const text = fs.readFileSync(file, 'utf8');
        let match = COLOUR_CLASS.exec(text);
        while (match) {
            const name = match[0];
            if (!used.has(name)) used.set(name, new Set());
            used.get(name).add(path.relative(ROOT, file).replace(/\\/g, '/'));
            match = COLOUR_CLASS.exec(text);
        }
    });
    return used;
}

// Every class named in a rule under html.dark.
function coloursWithDarkRules() {
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const from = css.indexOf('html.dark');
    assert.notStrictEqual(from, -1, 'style.css has no dark mode rules at all');

    const covered = new Set();
    (css.slice(from).match(/\.[-A-Za-z0-9]+/g) || []).forEach((selector) => {
        covered.add(selector.slice(1));
    });
    return covered;
}

const used = coloursInUse();
const covered = coloursWithDarkRules();

test('every colour in the app is either handled in dark mode or listed as not needing it', () => {
    const unhandled = Array.from(used.keys())
        .filter((name) => !covered.has(name))
        .filter((name) => !Object.prototype.hasOwnProperty.call(CORRECT_IN_BOTH_MODES, name))
        .sort()
        .map((name) => `${name} (used in ${Array.from(used.get(name)).slice(0, 2).join(', ')})`);

    assert.deepStrictEqual(unhandled, [],
        'These set a colour but have no rule under html.dark. Either add one to the sweep at the '
        + 'bottom of style.css, or add the class to CORRECT_IN_BOTH_MODES in this file with a '
        + `reason:\n  ${unhandled.join('\n  ')}`);
});

test('the list of colours that need no dark rule stays honest', () => {
    // A colour nobody uses any more should come off the list, or it grows into a place where a real
    // problem can hide.
    const unused = Object.keys(CORRECT_IN_BOTH_MODES).filter((name) => !used.has(name));
    assert.deepStrictEqual(unused, [],
        `no longer used anywhere, so remove from CORRECT_IN_BOTH_MODES: ${unused}`);

    Object.entries(CORRECT_IN_BOTH_MODES).forEach(([name, reason]) => {
        assert.ok(reason && reason.length > 20, `${name} needs a real reason, not "${reason}"`);
    });
});

test('dark mode is driven by tokens rather than a colour per rule', () => {
    // The point of the sweep is that a shade is defined once. If the number of raw hex colours in the
    // dark rules climbs, it has gone back to being patched panel by panel.
    const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
    const sweep = css.slice(css.indexOf('Dark mode, swept'));

    assert.ok(sweep.includes('--surface-raised'), 'the surface tokens are missing');
    assert.ok(sweep.includes('--tint-blue-bg'), 'the tint tokens are missing');

    // The real rule: a shade is written once, where the tokens are declared, and every rule after
    // that refers to it by name. So there should be no raw colour values in the rules themselves.
    // Everything after the token declarations, which is where the rules begin.
    const rulesStart = sweep.indexOf('/* Neutral surfaces. */');
    assert.notStrictEqual(rulesStart, -1, 'the sweep no longer starts its rules where expected');
    const rulesOnly = sweep.slice(rulesStart);
    const rawColours = (rulesOnly.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || []);
    assert.deepStrictEqual(rawColours, [],
        `the sweep should name tokens, not colours. Found: ${rawColours.join(', ')}`);

    const tokenUses = (rulesOnly.match(/var\(--[a-z-]+\)/g) || []).length;
    assert.ok(tokenUses > 10, `expected the rules to use tokens throughout, found ${tokenUses}`);
});

test('the tinted panels in settings are covered, since those were the worst of it', () => {
    // Named individually because these are the ones that were actually wrong: a pale blue, green or
    // red panel with dark text, sitting on a dark page.
    ['bg-blue-100', 'bg-green-100', 'bg-red-100'].forEach((name) => {
        assert.ok(used.has(name), `${name} is no longer used, so this test needs updating`);
        assert.ok(covered.has(name), `${name} still has no dark rule`);
    });
});

test('the close control on every panel is the same control', () => {
    // The chat history panel had its own hand rolled close button, so every dark mode rule written
    // for .modal-close-btn missed it and it stayed invisible on a dark background.
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

    ['close-edit-modal', 'close-history-modal-btn'].forEach((id) => {
        const pattern = new RegExp(`<button[^>]*id="${id}"[^>]*>`);
        const tag = html.match(pattern);
        assert.ok(tag, `${id} is not in index.html`);
        assert.match(tag[0], /class="[^"]*\bmodal-close-btn\b/,
            `${id} should use modal-close-btn so it is styled and themed like every other close control`);
    });
});
