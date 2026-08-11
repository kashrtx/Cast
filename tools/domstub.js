// A pretend browser, just complete enough to let the whole app load and start.
//
// Why this exists
//
// The app is a browser app, so none of it could be run here before. That meant a change to the
// interface code could only be checked by opening the page and clicking, and a typo in a file that
// only runs at start up would not show up until someone loaded the app.
//
// This is not a browser and does not try to be. Elements do not lay out, nothing is drawn, and
// styles go nowhere. What it does give is a page whose elements answer to being read, written,
// listened to and appended, which is all the start up code needs. That is enough to prove every
// file parses, loads in the right order, and that starting the app runs to the end without
// throwing.
//
// Anything a real browser has that the app happens to touch comes back as a permissive stand in
// rather than undefined, so a missing corner shows up as a test failure in the app rather than as a
// crash inside this file.

const NOOP = () => {};

function makeClassList() {
    const set = new Set();
    return {
        add: (...names) => names.forEach((n) => set.add(n)),
        remove: (...names) => names.forEach((n) => set.delete(n)),
        toggle: (name, force) => {
            const on = force === undefined ? !set.has(name) : !!force;
            if (on) set.add(name); else set.delete(name);
            return on;
        },
        contains: (name) => set.has(name),
        get length() { return set.size; },
        toString: () => Array.from(set).join(' '),
    };
}

function makeStyle() {
    const target = { setProperty: NOOP, removeProperty: NOOP, getPropertyValue: () => '' };
    return new Proxy(target, {
        get(obj, prop) {
            if (prop in obj) return obj[prop];
            return '';
        },
        set(obj, prop, value) { obj[prop] = value; return true; },
    });
}

let nextId = 0;

// An element that answers to anything, so an unexpected property read is not a crash.
function makeElement(tag = 'div', doc = null) {
    const listeners = {};
    const children = [];
    const attributes = {};

    const base = {
        nodeType: 1,
        tagName: String(tag).toUpperCase(),
        __stubId: nextId += 1,
        id: '',
        className: '',
        classList: makeClassList(),
        style: makeStyle(),
        dataset: {},
        children,
        childNodes: children,
        attributes,
        value: '',
        checked: false,
        disabled: false,
        // Plain string attributes. These are spelled out because the app reads some of them and
        // then calls string methods on the result, so handing back undefined would make the
        // harness itself the thing that fails.
        content: '',
        name: '',
        type: '',
        rel: '',
        alt: '',
        title: '',
        placeholder: '',
        open: false,
        textContent: '',
        innerText: '',
        innerHTML: '',
        outerHTML: '',
        src: '',
        href: '',
        files: [],
        selectedIndex: 0,
        options: [],
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        clientWidth: 0,
        offsetHeight: 0,
        offsetWidth: 0,
        offsetTop: 0,
        parentNode: null,
        parentElement: null,
        nextSibling: null,
        previousSibling: null,
        firstChild: null,
        lastChild: null,

        addEventListener(type, fn) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            if (!listeners[type]) return;
            listeners[type] = listeners[type].filter((f) => f !== fn);
        },
        dispatchEvent(event) {
            const type = event && event.type;
            (listeners[type] || []).forEach((fn) => fn.call(base, event));
            return true;
        },
        // Test helper: fire a listener the app registered.
        __fire(type, event = {}) {
            const withDefaults = {
                type,
                target: base,
                currentTarget: base,
                preventDefault: NOOP,
                stopPropagation: NOOP,
                ...event,
            };
            (listeners[type] || []).forEach((fn) => fn.call(base, withDefaults));
        },
        __listeners: listeners,

        appendChild(child) {
            children.push(child);
            if (child && typeof child === 'object') {
                child.parentNode = base;
                child.parentElement = base;
            }
            base.firstChild = children[0];
            base.lastChild = children[children.length - 1];
            return child;
        },
        append(...nodes) { nodes.forEach((n) => base.appendChild(n)); },
        removeChild(child) {
            const at = children.indexOf(child);
            if (at !== -1) children.splice(at, 1);
            return child;
        },
        remove() {
            if (base.parentNode) base.parentNode.removeChild(base);
        },
        insertBefore(child) { return base.appendChild(child); },
        replaceChildren(...nodes) { children.length = 0; nodes.forEach((n) => base.appendChild(n)); },
        cloneNode() { return makeElement(tag, doc); },
        contains: () => false,
        closest: () => null,
        matches: () => false,
        setAttribute(name, value) {
            attributes[name] = String(value);
            if (name === 'id') {
                base.id = String(value);
                if (doc && doc.__registerId) doc.__registerId(base.id, proxy);
            }
            if (name === 'class') base.className = String(value);
        },
        getAttribute(name) {
            if (name === 'id') return base.id || null;
            if (name === 'class') return base.className || null;
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
        hasAttribute(name) {
            if (name === 'id') return !!base.id;
            return Object.prototype.hasOwnProperty.call(attributes, name);
        },
        removeAttribute(name) { delete attributes[name]; },
        querySelector: () => (doc ? doc.__lookupSelector() : null),
        querySelectorAll: () => [],
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        getBoundingClientRect: () => ({
            top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0,
        }),
        focus: NOOP,
        blur: NOOP,
        click() { base.__fire('click'); },
        select: NOOP,
        scrollIntoView: NOOP,
        scrollTo: NOOP,
        setSelectionRange: NOOP,
        submit: NOOP,
        reset: NOOP,
        play: () => Promise.resolve(),
        pause: NOOP,
        insertAdjacentHTML: NOOP,
        animate: () => ({ finished: Promise.resolve(), cancel: NOOP }),
    };

    const proxy = new Proxy(base, {
        get(obj, prop) {
            if (prop in obj) return obj[prop];
            if (typeof prop === 'symbol') return undefined;
            // Unknown property: hand back something harmless rather than exploding.
            return undefined;
        },
        set(obj, prop, value) {
            obj[prop] = value;
            // Giving an element an id is how the app makes something findable later.
            if (prop === 'id' && value && doc && doc.__registerId) {
                doc.__registerId(String(value), proxy);
            }
            return true;
        },
        has() { return true; },
    });

    return proxy;
}

// The ids the page really has are passed in. Anything else is genuinely not there, and asking for it
// gives null, the same as in a browser.
//
// Handing back an element for any id asked for was the earlier behaviour and it was worse than
// useless: it made every `if (element)` check true, so the app took branches a browser never would.
// One of those branches then called element.parentNode.replaceChild on an element that had no
// parent, and the resulting failure looked like a bug in the app when it was a bug in here.
function createDocument(staticIds = []) {
    const byId = new Map();
    const realIds = new Set(staticIds);

    const doc = {
        readyState: 'loading',
        __listeners: {},
        __byId: byId,
        __created: [],
        __lookupSelector() { return null; },

        getElementById(id) {
            const key = String(id);
            if (byId.has(key)) return byId.get(key);
            if (!realIds.has(key)) return null;

            const el = makeElement('div', doc);
            el.id = key;
            byId.set(key, el);
            // Attached, so it has a parent. Code that swaps an element for a fresh clone reaches for
            // parentNode, and a detached element would fail there and nowhere near the real cause.
            doc.body.appendChild(el);
            return el;
        },

        // An element the app built itself and gave an id to becomes findable, the same as it would
        // once it were added to the page. Elements built by assigning innerHTML are not tracked,
        // because nothing here parses HTML, so looking one of those up gives null.
        __registerId(id, element) {
            const key = String(id);
            if (!key) return;
            realIds.add(key);
            if (!byId.has(key)) byId.set(key, element);
        },

        // What a test can rely on being there.
        __realIds: realIds,
        createElement(tag) {
            const el = makeElement(tag, doc);
            doc.__created.push(el);
            return el;
        },
        createTextNode(text) { return { nodeType: 3, textContent: text, __text: true }; },
        createDocumentFragment() { return makeElement('fragment', doc); },
        createRange() {
            return {
                selectNodeContents: NOOP,
                setStart: NOOP,
                setEnd: NOOP,
                collapse: NOOP,
                createContextualFragment: () => makeElement('fragment', doc),
            };
        },
        querySelector(selector) {
            const idMatch = /^#([\w-]+)$/.exec(String(selector).trim());
            if (idMatch) return doc.getElementById(idMatch[1]);
            return doc.__selectorElement(selector);
        },
        querySelectorAll() { return []; },
        getElementsByClassName: () => [],
        getElementsByTagName: () => [],
        addEventListener(type, fn) {
            if (!doc.__listeners[type]) doc.__listeners[type] = [];
            doc.__listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            if (!doc.__listeners[type]) return;
            doc.__listeners[type] = doc.__listeners[type].filter((f) => f !== fn);
        },
        dispatchEvent: () => true,
        execCommand: () => true,
        fonts: { ready: Promise.resolve(), load: () => Promise.resolve(), check: () => true },
    };

    // Named selectors the app asks for by tag or class rather than id.
    const namedCache = new Map();
    doc.__selectorElement = (selector) => {
        const key = String(selector);
        if (!namedCache.has(key)) namedCache.set(key, makeElement('div', doc));
        return namedCache.get(key);
    };

    doc.body = makeElement('body', doc);
    doc.head = makeElement('head', doc);
    doc.documentElement = makeElement('html', doc);
    doc.activeElement = doc.body;

    // Fire the handlers the app registered for a document event.
    doc.__fire = (type, event = {}) => {
        const withDefaults = {
            type, target: doc, preventDefault: NOOP, stopPropagation: NOOP, ...event,
        };
        return Promise.all((doc.__listeners[type] || []).map((fn) => {
            const result = fn.call(doc, withDefaults);
            return result && typeof result.then === 'function' ? result : Promise.resolve(result);
        }));
    };

    return doc;
}

function createLocalStorage(seed = {}) {
    const map = new Map(Object.entries(seed));
    return {
        getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
        setItem: (key, value) => { map.set(String(key), String(value)); },
        removeItem: (key) => { map.delete(String(key)); },
        clear: () => map.clear(),
        key: (index) => Array.from(map.keys())[index] ?? null,
        get length() { return map.size; },
        __map: map,
    };
}

// Builds the object that stands in for `window`, and which doubles as the global scope the app
// files are evaluated in.
function createWindow(options = {}) {
    // 'record' keeps the waits and runs none of them, which is right for start up.
    // 'fast'   runs them with the waits collapsed, for tests about ordering.
    // 'real'   runs them at their real length, for tests about a wait itself. Collapsing the waits
    //          would collapse the very thing under test: a one second limit became one millisecond,
    //          so a request appeared to give up instantly and the test looked broken.
    const timerMode = options.timers === 'fast' ? 'fast'
        : (options.timers === 'real' ? 'real' : 'record');
    const fastTimers = timerMode !== 'record';
    const collapseWaits = timerMode === 'fast';
    // Fast timers are real timers, so they hold the process open after a test has finished. Every
    // handle is tracked and __clearAllTimers() lets go of all of them.
    const liveTimers = new Set();
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;
    const realSetInterval = setInterval;
    const realClearInterval = clearInterval;
    const document = createDocument(options.staticIds || []);
    const localStorage = createLocalStorage(options.storage || {});
    const timers = [];

    const win = {
        document,
        localStorage,
        sessionStorage: createLocalStorage(),
        name: 'cast-test-window',
        innerWidth: options.innerWidth || 1280,
        innerHeight: options.innerHeight || 800,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        location: {
            href: 'http://localhost/index.html',
            origin: 'http://localhost',
            protocol: 'http:',
            host: 'localhost',
            hostname: 'localhost',
            pathname: '/index.html',
            search: '',
            hash: '',
            reload: NOOP,
            assign: NOOP,
            replace: NOOP,
        },
        navigator: {
            userAgent: 'node-cast-harness',
            language: 'en-GB',
            languages: ['en-GB'],
            onLine: true,
            clipboard: { writeText: () => Promise.resolve() },
            storage: { estimate: () => Promise.resolve({ usage: 0, quota: 0 }) },
        },
        history: { pushState: NOOP, replaceState: NOOP, back: NOOP },
        __listeners: {},
        __timers: timers,

        addEventListener(type, fn) {
            if (!win.__listeners[type]) win.__listeners[type] = [];
            win.__listeners[type].push(fn);
        },
        removeEventListener(type, fn) {
            if (!win.__listeners[type]) return;
            win.__listeners[type] = win.__listeners[type].filter((f) => f !== fn);
        },
        dispatchEvent: () => true,
        __fire(type, event = {}) {
            const withDefaults = { type, preventDefault: NOOP, stopPropagation: NOOP, ...event };
            (win.__listeners[type] || []).forEach((fn) => fn.call(win, withDefaults));
        },

        // Timers are recorded rather than run by default. Start up defers a lot of work to them, and
        // running all of it would take the harness far past the question of whether the app starts.
        //
        // Pass timers: 'fast' to run them for real, with the waits collapsed. That is what the tests
        // about doing something else while a reply is arriving need: the reply path waits before it
        // asks the model, so with no timers it never gets that far, and with real waits the test would
        // take as long as the app does.
        setTimeout(fn, delay, ...args) {
            if (!fastTimers) { timers.push({ fn, delay }); return timers.length; }
            const wait = collapseWaits ? Math.min(Number(delay) || 0, 1) : (Number(delay) || 0);
            const handle = realSetTimeout(fn, wait, ...args);
            liveTimers.add(handle);
            return handle;
        },
        clearTimeout(handle) {
            if (!fastTimers) return;
            realClearTimeout(handle);
            liveTimers.delete(handle);
        },
        setInterval(fn, delay, ...args) {
            if (!fastTimers) { timers.push({ fn, delay, repeating: true }); return timers.length; }
            // Kept slow on purpose. These are the "still thinking" status updates, which are not what
            // any test is about, and a fast repeating timer would spin for the length of the run.
            const every = collapseWaits ? Math.max(Number(delay) || 0, 1000) : (Number(delay) || 0);
            const handle = realSetInterval(fn, every, ...args);
            liveTimers.add(handle);
            return handle;
        },
        clearInterval(handle) {
            if (!fastTimers) return;
            realClearInterval(handle);
            liveTimers.delete(handle);
        },

        // Lets go of every timer still running. A test calls this when it is done, or the process
        // stays alive and the run appears to hang after every test has already passed.
        __clearAllTimers() {
            liveTimers.forEach((handle) => {
                realClearTimeout(handle);
                realClearInterval(handle);
            });
            liveTimers.clear();
        },
        requestAnimationFrame(fn) {
            if (!fastTimers) { timers.push({ fn, delay: 0, frame: true }); return timers.length; }
            const handle = realSetTimeout(fn, 0);
            liveTimers.add(handle);
            return handle;
        },
        cancelAnimationFrame(handle) {
            if (fastTimers) realClearTimeout(handle);
        },
        queueMicrotask: (fn) => Promise.resolve().then(fn),

        matchMedia: (query) => ({
            matches: false,
            media: query,
            addEventListener: NOOP,
            removeEventListener: NOOP,
            addListener: NOOP,
            removeListener: NOOP,
        }),
        getComputedStyle: () => makeStyle(),

        alert: NOOP,
        confirm: () => true,
        prompt: () => null,
        open: () => null,
        close: NOOP,
        print: NOOP,
        focus: NOOP,
        scrollTo: NOOP,

        // Network is never reached. Anything that tries gets a clear failure rather than a hang.
        fetch: () => Promise.reject(new Error('network is not available in the test harness')),

        crypto: {
            getRandomValues(array) {
                for (let i = 0; i < array.length; i += 1) {
                    array[i] = Math.floor(Math.random() * 256);
                }
                return array;
            },
            randomUUID: () => '00000000-0000-4000-8000-000000000000',
            subtle: {},
        },
        performance: { now: () => Date.now() },
        // Deliberately absent. The picture store checks for IndexedDB and falls back cleanly when
        // it is missing, which is the path this harness wants: no database, no pending callbacks
        // that never fire, and the same code a private browsing window takes.
        URL: {
            createObjectURL: () => 'blob:stub',
            revokeObjectURL: NOOP,
        },
        Blob: class Blob {
            constructor(parts = [], opts = {}) {
                this.parts = parts;
                this.type = opts.type || '';
                this.size = parts.join('').length;
            }
            text() { return Promise.resolve(this.parts.join('')); }
        },
        File: class File {},
        FileReader: class FileReader {
            constructor() {
                this.onload = null;
                this.onerror = null;
                this.result = null;
            }
            readAsText() { this.result = ''; if (this.onload) this.onload({ target: this }); }
            readAsDataURL() { this.result = 'data:,'; if (this.onload) this.onload({ target: this }); }
        },
        Image: class Image {
            constructor() {
                this.onload = null;
                this.onerror = null;
                this.width = 0;
                this.height = 0;
                this.__src = '';
            }
            set src(value) { this.__src = value; }
            get src() { return this.__src; }
        },
        FormData: class FormData {},
        Headers: class Headers {},
        // The real one, not a stand in. It used to be a class with an empty object for a signal, so
        // anything that added an abort listener threw immediately. That made a request appear to fail
        // instantly, which is the opposite of the behaviour the timeout tests are about, and it would
        // have hidden a real fault in exactly the same way.
        AbortController,
        AbortSignal,
        MutationObserver: class MutationObserver {
            constructor(fn) { this.fn = fn; }
            observe() {}
            disconnect() {}
        },
        ResizeObserver: class ResizeObserver {
            constructor(fn) { this.fn = fn; }
            observe() {}
            unobserve() {}
            disconnect() {}
        },
        IntersectionObserver: class IntersectionObserver {
            constructor(fn) { this.fn = fn; }
            observe() {}
            disconnect() {}
        },
        TextEncoder,
        TextDecoder,
        structuredClone: (value) => JSON.parse(JSON.stringify(value)),

        // The page loads this from a CDN. It is not reimplemented here, because a stand in that
        // sanitised would only ever be testing itself. What it does instead is record every call, so
        // a test can check that content from a model is routed through the sanitiser at all, which
        // is the part that is ours to get right. Whether DOMPurify then does its job is DOMPurify's
        // business and is tested by DOMPurify.
        DOMPurify: {
            sanitize: (html, options) => {
                win.__sanitizerCalls.push({ html: String(html), options });
                return String(html);
            },
            addHook: NOOP,
            isSupported: true,
        },
        __sanitizerCalls: [],

        // Console output captured by the loader, so a test can look at what was logged.
        __logged: [],

        // Set by an inline script in the page.
        debugApp: false,

        console,
        Promise,
        Date,
        Math,
        JSON,
        Object,
        Array,
        String,
        Number,
        Boolean,
        Error,
        TypeError,
        RangeError,
        Map,
        Set,
        WeakMap,
        WeakSet,
        Symbol,
        Proxy,
        Reflect,
        RegExp,
        Function,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
        atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
        Intl,
        BigInt,
        ArrayBuffer,
        Uint8Array,
        Uint16Array,
        Uint32Array,
        Int8Array,
        Float32Array,
        Float64Array,
        DataView,
    };

    win.window = win;
    win.self = win;
    win.globalThis = win;
    win.top = win;
    win.parent = win;

    return win;
}

// Turns a stub element back into something like HTML.
//
// This exists because several functions in the app build an element and return it rather than
// returning a string, so there is nothing to assert on without walking it. It is not a correct HTML
// serialiser and does not try to be; it is enough to check that the text arrived, that the markdown
// became tags, and that nothing unexpected is in there.
//
// It also stops a test quietly passing on nothing: an element stringifies to "[object Object]", so a
// test that forgets to serialise compares fifteen identical characters and proves nothing.
function serialize(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (node.nodeType === 3 || node.__text) return String(node.textContent || '');

    const tag = String(node.tagName || 'div').toLowerCase();
    const parts = [];

    if (node.id) parts.push(` id="${node.id}"`);
    const classes = String(node.className || node.classList || '');
    if (classes) parts.push(` class="${classes}"`);
    Object.keys(node.attributes || {}).forEach((name) => {
        if (name === 'id' || name === 'class') return;
        parts.push(` ${name}="${node.attributes[name]}"`);
    });

    // Whichever of these the app set is the content. innerHTML wins, since that is what the app uses
    // when it has already built markup.
    let inner = '';
    if (node.innerHTML) inner = String(node.innerHTML);
    else if (node.children && node.children.length) {
        inner = node.children.map((child) => serialize(child)).join('');
    } else if (node.textContent) {
        inner = String(node.textContent);
    }

    return `<${tag}${parts.join('')}>${inner}</${tag}>`;
}

module.exports = { createWindow, createDocument, createLocalStorage, makeElement, serialize };
