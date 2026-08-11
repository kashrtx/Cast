// Loads the app the way the page does, into the pretend browser.
//
// The list of files is read out of index.html rather than written down here on purpose. If someone
// adds a file and forgets to put it in the page, or puts it in the page in the wrong place, these
// tests load exactly what a visitor would load and so they see the same problem. Keeping a second
// copy of the list would have hidden it.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createWindow, serialize } = require('./domstub');

const ROOT = path.join(__dirname, '..');

// Every local script the page loads, in order. Ones fetched from a CDN are skipped, since they are
// not ours and the stub already stands in for the only one the app calls into.
function scriptsFromPage(pageFile = path.join(ROOT, 'index.html')) {
    const html = fs.readFileSync(pageFile, 'utf8');
    const found = [];
    const pattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match = pattern.exec(html);
    while (match) {
        const src = match[1];
        if (!/^https?:|^\/\//i.test(src)) found.push(src);
        match = pattern.exec(html);
    }
    return found;
}

// Every id the page actually contains. The stub answers getElementById from this, so an element the
// page does not have comes back as null the way it would in a browser.
function idsFromPage(pageFile = path.join(ROOT, 'index.html')) {
    const html = fs.readFileSync(pageFile, 'utf8');
    const found = new Set();
    const pattern = /\bid\s*=\s*["']([^"']+)["']/gi;
    let match = pattern.exec(html);
    while (match) {
        found.add(match[1]);
        match = pattern.exec(html);
    }
    return Array.from(found);
}

// Runs every file in order and hands back the window they built.
function loadApp(options = {}) {
    const win = createWindow({
        staticIds: idsFromPage(options.page),
        ...options,
    });
    // The app talks to the console a great deal at start up. Left alone, a test run buries its own
    // results under thousands of lines of it and nobody reads either. It is captured rather than
    // thrown away, so a test can still check what was logged.
    const logged = [];
    if (options.quiet !== false) {
        const record = (level) => (...args) => {
            logged.push({ level, text: args.map((a) => (a && a.message) || String(a)).join(' ') });
        };
        win.console = {
            log: record('log'),
            info: record('info'),
            warn: record('warn'),
            error: record('error'),
            debug: record('debug'),
            trace: record('trace'),
            table: record('table'),
            group: () => {},
            groupEnd: () => {},
            dir: record('dir'),
            time: () => {},
            timeEnd: () => {},
            assert: () => {},
            count: () => {},
        };
    }
    win.__logged = logged;

    const context = vm.createContext(win);
    const problems = [];
    const files = options.files || scriptsFromPage(options.page);

    files.forEach((relative) => {
        const full = path.join(ROOT, relative);
        if (!fs.existsSync(full)) {
            problems.push({ file: relative, error: new Error('file listed in index.html is missing') });
            return;
        }
        const code = fs.readFileSync(full, 'utf8');
        try {
            vm.runInContext(code, context, { filename: relative });
        } catch (error) {
            problems.push({ file: relative, error });
        }
    });

    return { win, context, files, problems };
}

// Starts the app, the way the browser does once the page is parsed.
async function bootApp(options = {}) {
    const loaded = loadApp(options);
    loaded.win.document.readyState = 'interactive';

    const failures = [];
    // A boot that never finishes is a failure too, and without this the test process would simply
    // exit quietly with nothing reported.
    const settleLimit = options.settleMs || 5000;
    let timer = null;
    const ranOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve('__timeout__'), settleLimit);
    });

    try {
        const outcome = await Promise.race([
            loaded.win.document.__fire('DOMContentLoaded').then(() => '__done__'),
            ranOut,
        ]);
        if (outcome === '__timeout__') {
            failures.push(new Error(`start up did not finish within ${settleLimit}ms`));
        }
    } catch (error) {
        failures.push(error);
    } finally {
        clearTimeout(timer);
    }
    loaded.win.document.readyState = 'complete';

    // Each start up step runs inside its own guard so that one failing does not stop the rest. That
    // is the right behaviour for someone using the app and the wrong behaviour for a test: nothing is
    // thrown, so a broken step used to look like a clean start. The app records every one it caught
    // in its own log, which is read back here.
    const stepFailures = [];
    try {
        const kind = vm.runInContext('CastLog && CastLog.KINDS && CastLog.KINDS.STARTUP_FAILED', loaded.context);
        const entries = vm.runInContext('JSON.stringify((typeof state !== "undefined" && state.activityLog) || [])', loaded.context);
        JSON.parse(entries).forEach((entry) => {
            if (entry && entry.kind === kind) stepFailures.push(entry.detail || 'unnamed step');
        });
    } catch (error) {
        // No log to read. Recorded as no failures rather than guessed at.
    }

    return { ...loaded, failures, stepFailures };
}

// The names the app puts into the shared scope. Used to prove a refactor did not lose or rename
// anything: the list before and the list after have to match.
function globalsDefined(loaded, skipFiles = []) {
    const skip = new Set(skipFiles);
    const own = new Set();
    const baseline = new Set(Object.keys(createWindow()));

    Object.keys(loaded.win).forEach((key) => {
        if (!baseline.has(key)) own.add(key);
    });

    // let and const at the top level of a classic script live in the global lexical scope, which
    // does not show up as a property of the window. They are read back by name instead.
    const lexical = [];
    loaded.files.forEach((relative) => {
        if (skip.has(relative)) return;
        const full = path.join(ROOT, relative);
        if (!fs.existsSync(full)) return;
        const code = fs.readFileSync(full, 'utf8');
        const pattern = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
        let match = pattern.exec(code);
        while (match) {
            lexical.push(match[1]);
            match = pattern.exec(code);
        }
    });

    lexical.forEach((name) => {
        try {
            const exists = vm.runInContext(`typeof ${name} !== "undefined"`, loaded.context);
            if (exists) own.add(name);
        } catch (error) {
            // A name in a temporal dead zone or shadowed. Recorded as absent.
        }
    });

    return Array.from(own).sort();
}

// The type of each name, so a function cannot quietly become something else.
function globalKinds(loaded, names) {
    const kinds = {};
    names.forEach((name) => {
        try {
            kinds[name] = vm.runInContext(`typeof ${name}`, loaded.context);
        } catch (error) {
            kinds[name] = 'unreadable';
        }
    });
    return kinds;
}

module.exports = {
    scriptsFromPage, idsFromPage, loadApp, bootApp, globalsDefined, globalKinds, serialize, ROOT,
};
