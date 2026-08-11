// Tests about how the code is arranged rather than what it does.
//
// The app used to be one file of 8,301 lines. Splitting it up is only worth anything if it stays
// split, and if the page and the files on disk keep agreeing with each other. These are the checks
// that hold that in place, and they are the ones most likely to catch a mistake in a pull request
// that adds a file.
//
// The rules they enforce:
//   - every script the page loads exists, and every file on disk is loaded by the page
//   - no two files declare the same name, since they share one scope and the later would win
//   - only src/app/boot.js runs anything at load time, which is what makes the order safe
//   - nothing grows past a size where it should have been split

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { scriptsFromPage, ROOT } = require('../tools/loadapp');
const { splitDeclarations, nameOf } = require('../tools/chunker');

// No file should get near this. It is set well above the largest one so that it is a backstop
// against a slide back to one enormous file, not a nag about a hundred lines.
const LINE_BUDGET = 800;

// Paths are compared against the ones written in index.html, which use forward slashes because that
// is what a URL uses. On Windows path.relative hands back backslashes, so every comparison here
// failed and the tests reported that the page loaded none of its own files. Everything that comes off
// the disk is put into the same shape as the page before it is compared to anything.
function asUrlPath(value) {
    // Both separators, not just the one this platform prefers, since a path can come back mixed.
    return String(value).replace(/\\/g, '/');
}

function everyScriptOnDisk() {
    const found = [];
    const walk = (dir) => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.js')) found.push(asUrlPath(path.relative(ROOT, full)));
        });
    };
    walk(path.join(ROOT, 'src'));
    return found.sort();
}

const listedInPage = scriptsFromPage();
const onDisk = everyScriptOnDisk();

test('every script the page loads is actually there', () => {
    const missing = listedInPage.filter((file) => !fs.existsSync(path.join(ROOT, file)));
    assert.deepStrictEqual(missing, [], `index.html lists files that do not exist: ${missing}`);
});

test('every file in src is loaded by the page', () => {
    // A file nobody loads is a file whose bugs nobody sees until the day something requires it.
    const orphaned = onDisk.filter((file) => !listedInPage.includes(file));
    assert.deepStrictEqual(orphaned, [], `these exist but the page never loads them: ${orphaned}`);
});

test('nothing is loaded twice', () => {
    const seen = new Set();
    const twice = listedInPage.filter((file) => {
        if (seen.has(file)) return true;
        seen.add(file);
        return false;
    });
    assert.deepStrictEqual(twice, [], `loaded more than once: ${twice}`);
});

test('shared data comes before the files that read it, and start up comes last', () => {
    const state = listedInPage.indexOf('src/app/state.js');
    const boot = listedInPage.indexOf('src/app/boot.js');
    assert.ok(state !== -1, 'src/app/state.js is not loaded');
    assert.ok(boot !== -1, 'src/app/boot.js is not loaded');

    const firstApp = listedInPage.findIndex((file) => file.startsWith('src/app/'));
    assert.strictEqual(listedInPage[firstApp], 'src/app/state.js',
        'state.js has to be the first app file, because everything else reads from it');
    assert.strictEqual(boot, listedInPage.length - 1,
        'boot.js has to be last, because it is the only file that runs anything');
});

test('only boot.js does anything at load time', () => {
    // This is the property that makes the load order safe to change. Every app file only declares
    // functions, so nothing depends on having run before anything else. If one starts executing at
    // load time, the order suddenly matters and a reordering becomes a real bug.
    //
    // The files directly in src/ are exempt and have to be: each is wrapped in a function that runs
    // on load to publish itself, which is what lets the same file work in the page and under Node.
    const offenders = [];
    listedInPage.filter((file) => file.startsWith('src/app/')).forEach((file) => {
        if (file === 'src/app/boot.js') return;
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        const statements = splitDeclarations(source)
            .filter((chunk) => nameOf(chunk.text).kind === 'statement');
        if (statements.length) {
            offenders.push(`${file} (line ${statements[0].startLine})`);
        }
    });
    assert.deepStrictEqual(offenders, [],
        `these run code at load time, which only boot.js may do: ${offenders}`);
});

test('no two files declare the same name', () => {
    // Every one of these files shares a single scope. Two files declaring the same function is not
    // an error the browser reports: the second quietly replaces the first, and the first becomes
    // code that looks live and never runs. That happened once already, with callGeminiAPI.
    const owners = new Map();
    const clashes = [];

    listedInPage.filter((file) => file.startsWith('src/app/')).forEach((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        splitDeclarations(source).forEach((chunk) => {
            const info = nameOf(chunk.text);
            if (!info.name) return;
            if (owners.has(info.name)) {
                clashes.push(`${info.name} is declared in both ${owners.get(info.name)} and ${file}`);
                return;
            }
            owners.set(info.name, file);
        });
    });

    assert.deepStrictEqual(clashes, [], clashes.join('; '));
});

test('no file has grown back into a monolith', () => {
    const toobig = onDisk
        .map((file) => ({ file, lines: fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length - 1 }))
        .filter((entry) => entry.lines > LINE_BUDGET)
        .map((entry) => `${entry.file} is ${entry.lines} lines`);

    assert.deepStrictEqual(toobig, [],
        `over the ${LINE_BUDGET} line budget, split them: ${toobig}`);
});

test('every file explains itself at the top', () => {
    // Someone arriving at this project should be able to open any file and find out in a few lines
    // what it is for. This checks there is a comment, not that it is a good one.
    const undocumented = onDisk.filter((file) => {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        return !source.trimStart().startsWith('//');
    });
    assert.deepStrictEqual(undocumented, [], `no header comment: ${undocumented}`);
});

test('file paths are compared in the same shape the page writes them', () => {
    // This is here because the bug it guards against cannot be seen on Linux or macOS. On Windows
    // the paths came back with backslashes, nothing matched, and two tests failed for a reason that
    // had nothing to do with what they were checking.
    onDisk.forEach((file) => {
        assert.ok(!file.includes('\\'), `${file} has a backslash in it, so it will not match the page`);
        assert.ok(file.startsWith('src/'), `${file} should be written the way index.html writes it`);
    });
    assert.strictEqual(asUrlPath('src\\app\\ui\\theme.js'), 'src/app/ui/theme.js');
    assert.strictEqual(asUrlPath('src/app/ui/theme.js'), 'src/app/ui/theme.js');
    assert.strictEqual(asUrlPath('src\\app/ui\\theme.js'), 'src/app/ui/theme.js');
});

test('the split left the app in more than a handful of files', () => {
    const appFiles = onDisk.filter((file) => file.startsWith('src/app/'));
    assert.ok(appFiles.length >= 30,
        `expected the app to be spread across at least 30 files, found ${appFiles.length}`);
});

test('the version is the same everywhere, and the changelog knows it', () => {
    // The version is what people paste when they ask for help, and it decides which set of bugs you
    // are looking at. Wrong in one place is worse than not having one.
    const brand = require('../src/brand.js');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    assert.strictEqual(brand.appVersion, pkg.version,
        `src/brand.js says ${brand.appVersion} and package.json says ${pkg.version}`);

    assert.match(brand.appVersion, /^\d+\.\d+\.\d+$/,
        'the version should be three numbers, so it can be compared');

    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`## ${brand.appVersion}`),
        `CHANGELOG.md has no entry for ${brand.appVersion}. Add one before releasing it.`);
});

test('the newest changelog entry is the current version', () => {
    // A changelog whose top entry is not what is shipping means someone bumped one and not the other.
    const brand = require('../src/brand.js');
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

    const versions = (changelog.match(/^## (\d+\.\d+\.\d+)$/gm) || [])
        .map((line) => line.replace('## ', ''));

    assert.ok(versions.length > 0, 'CHANGELOG.md lists no versions at all');
    assert.strictEqual(versions[0], brand.appVersion,
        `the changelog opens with ${versions[0]} but the app says it is ${brand.appVersion}`);

    // And they go downwards, so the newest is at the top.
    const asNumbers = versions.map((v) => v.split('.').map(Number));
    for (let i = 1; i < asNumbers.length; i += 1) {
        const [a, b] = [asNumbers[i - 1], asNumbers[i]];
        const newer = a[0] !== b[0] ? a[0] > b[0] : (a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2]);
        assert.ok(newer, `${versions[i - 1]} should be newer than ${versions[i]}`);
    }
});
