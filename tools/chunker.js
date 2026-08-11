// Splits a classic script into its top-level pieces.
//
// This exists so the big-file split could be checked rather than trusted. It walks the source
// character by character, keeping track of whether it is inside a string, a template literal, a
// comment or a regex, so that a brace inside a prompt string is not mistaken for real code. Every
// run of text at brace depth zero comes back as one chunk, comments and blank lines included.
//
// The point of it is the round trip: joining the chunks back together has to give the original file
// back, byte for byte. If that holds, then moving whole chunks into separate files cannot change
// what the program does, because nothing inside a chunk was touched.

const fs = require('fs');

// Tokens after which a slash starts a regex rather than meaning divide.
const REGEX_OK_AFTER = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<',
    '>', 'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do',
    'else', 'yield', 'await',
]);

function lastSignificant(text, upto) {
    let i = upto - 1;
    while (i >= 0 && /\s/.test(text[i])) i -= 1;
    if (i < 0) return '(';
    if (/[A-Za-z_$0-9]/.test(text[i])) {
        let end = i + 1;
        while (i >= 0 && /[A-Za-z_$0-9]/.test(text[i])) i -= 1;
        return text.slice(i + 1, end);
    }
    return text[i];
}

// Returns an array of { text, startLine } covering the whole source with nothing lost.
function chunk(source) {
    const chunks = [];
    let chunkStart = 0;
    let line = 1;
    let chunkStartLine = 1;

    let depth = 0; // curly braces only
    let paren = 0;
    let bracket = 0;

    // Template literal nesting: each entry is the paren/brace depth at which the ${ opened.
    const templates = [];

    let i = 0;
    const n = source.length;

    const cut = (end) => {
        if (end > chunkStart) {
            chunks.push({ text: source.slice(chunkStart, end), startLine: chunkStartLine });
        }
        chunkStart = end;
        chunkStartLine = line;
    };

    while (i < n) {
        const ch = source[i];

        if (ch === '\n') {
            line += 1;
            i += 1;
            continue;
        }

        // Line comment
        if (ch === '/' && source[i + 1] === '/') {
            while (i < n && source[i] !== '\n') i += 1;
            continue;
        }

        // Block comment
        if (ch === '/' && source[i + 1] === '*') {
            i += 2;
            while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
                if (source[i] === '\n') line += 1;
                i += 1;
            }
            i += 2;
            continue;
        }

        // Strings
        if (ch === '"' || ch === "'") {
            const quote = ch;
            i += 1;
            while (i < n) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i] === quote) { i += 1; break; }
                if (source[i] === '\n') line += 1; // unterminated, but keep counting
                i += 1;
            }
            continue;
        }

        // Template literal start
        if (ch === '`') {
            i += 1;
            let done = false;
            while (i < n && !done) {
                if (source[i] === '\\') { i += 2; continue; }
                if (source[i] === '\n') { line += 1; i += 1; continue; }
                if (source[i] === '`') { i += 1; done = true; break; }
                if (source[i] === '$' && source[i + 1] === '{') {
                    // Recurse through the substitution by handing control back to the main loop.
                    templates.push({ depth, paren, bracket });
                    depth += 1;
                    i += 2;
                    done = true; // leave the template scan; the main loop handles the ${ ... }
                    break;
                }
                i += 1;
            }
            continue;
        }

        // Regex literal
        if (ch === '/') {
            const prev = lastSignificant(source, i);
            if (REGEX_OK_AFTER.has(prev)) {
                i += 1;
                let inClass = false;
                while (i < n) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i] === '[') inClass = true;
                    else if (source[i] === ']') inClass = false;
                    else if (source[i] === '/' && !inClass) { i += 1; break; }
                    else if (source[i] === '\n') break; // not a regex after all
                    i += 1;
                }
                while (i < n && /[gimsuyd]/.test(source[i])) i += 1;
                continue;
            }
            i += 1;
            continue;
        }

        if (ch === '(') { paren += 1; i += 1; continue; }
        if (ch === ')') { paren -= 1; i += 1; continue; }
        if (ch === '[') { bracket += 1; i += 1; continue; }
        if (ch === ']') { bracket -= 1; i += 1; continue; }

        if (ch === '{') { depth += 1; i += 1; continue; }

        if (ch === '}') {
            depth -= 1;
            i += 1;
            // Closing a ${ } inside a template? Resume scanning the rest of that template.
            const top = templates[templates.length - 1];
            if (top && top.depth === depth && top.paren === paren && top.bracket === bracket) {
                templates.pop();
                let done = false;
                while (i < n && !done) {
                    if (source[i] === '\\') { i += 2; continue; }
                    if (source[i] === '\n') { line += 1; i += 1; continue; }
                    if (source[i] === '`') { i += 1; done = true; break; }
                    if (source[i] === '$' && source[i + 1] === '{') {
                        templates.push({ depth, paren, bracket });
                        depth += 1;
                        i += 2;
                        done = true;
                        break;
                    }
                    i += 1;
                }
            }
            continue;
        }

        if (ch === ';' && depth === 0 && paren === 0 && bracket === 0 && templates.length === 0) {
            i += 1;
            // A statement ended. Take the rest of the line (trailing comment) with it.
            let j = i;
            while (j < n && source[j] !== '\n' && /\s/.test(source[j])) j += 1;
            if (source[j] === '/' && (source[j + 1] === '/' )) {
                while (j < n && source[j] !== '\n') j += 1;
            }
            if (source[j] === '\n') { j += 1; line += 1; }
            i = j;
            cut(i);
            continue;
        }

        // A top-level block closed with } at column 0 and no semicolon (function declarations).
        if (depth === 0 && paren === 0 && bracket === 0 && templates.length === 0 && ch === '\n') {
            i += 1;
            continue;
        }

        i += 1;
    }

    cut(n);
    return chunks;
}

// A function declaration ends at `}` with nothing after it, which the semicolon rule above misses.
// Rather than special case it in the scanner, chunks are re-split here on the same principle:
// a line that is exactly `}` at column zero, at depth zero, ends a declaration.
function splitDeclarations(source) {
    const rough = chunk(source);
    const out = [];
    rough.forEach((piece) => {
        const lines = piece.text.split('\n');
        let buf = [];
        let startLine = piece.startLine;
        let seen = 0;
        let depth = 0;
        // Re-walk with the scanner per line to know when we are back at depth zero.
        lines.forEach((text) => {
            buf.push(text);
            depth = depthAfter(buf.join('\n'));
            if (depth === 0 && text === '}') {
                out.push({ text: buf.join('\n') + '\n', startLine: startLine + seen });
                seen += buf.length;
                buf = [];
            }
        });
        if (buf.length) {
            const trailing = buf.join('\n');
            if (trailing.length) out.push({ text: trailing, startLine: startLine + seen });
        }
    });
    return out;
}

// Brace depth at the end of a fragment, using the same scanner rules.
function depthAfter(fragment) {
    let depth = 0;
    let i = 0;
    const n = fragment.length;
    const templates = [];
    let paren = 0;
    let bracket = 0;
    while (i < n) {
        const ch = fragment[i];
        if (ch === '/' && fragment[i + 1] === '/') { while (i < n && fragment[i] !== '\n') i += 1; continue; }
        if (ch === '/' && fragment[i + 1] === '*') {
            i += 2;
            while (i < n && !(fragment[i] === '*' && fragment[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        if (ch === '"' || ch === "'") {
            const q = ch; i += 1;
            while (i < n) {
                if (fragment[i] === '\\') { i += 2; continue; }
                if (fragment[i] === q) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        if (ch === '`') {
            i += 1;
            while (i < n) {
                if (fragment[i] === '\\') { i += 2; continue; }
                if (fragment[i] === '`') { i += 1; break; }
                if (fragment[i] === '$' && fragment[i + 1] === '{') {
                    templates.push({ depth, paren, bracket });
                    depth += 1; i += 2; break;
                }
                i += 1;
            }
            continue;
        }
        if (ch === '/') {
            const prev = lastSignificant(fragment, i);
            if (REGEX_OK_AFTER.has(prev)) {
                i += 1;
                let inClass = false;
                while (i < n) {
                    if (fragment[i] === '\\') { i += 2; continue; }
                    if (fragment[i] === '[') inClass = true;
                    else if (fragment[i] === ']') inClass = false;
                    else if (fragment[i] === '/' && !inClass) { i += 1; break; }
                    else if (fragment[i] === '\n') break;
                    i += 1;
                }
                while (i < n && /[gimsuyd]/.test(fragment[i])) i += 1;
                continue;
            }
            i += 1; continue;
        }
        if (ch === '(') paren += 1;
        else if (ch === ')') paren -= 1;
        else if (ch === '[') bracket += 1;
        else if (ch === ']') bracket -= 1;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            depth -= 1;
            const top = templates[templates.length - 1];
            if (top && top.depth === depth && top.paren === paren && top.bracket === bracket) {
                templates.pop();
                i += 1;
                while (i < n) {
                    if (fragment[i] === '\\') { i += 2; continue; }
                    if (fragment[i] === '`') { i += 1; break; }
                    if (fragment[i] === '$' && fragment[i + 1] === '{') {
                        templates.push({ depth, paren, bracket });
                        depth += 1; i += 2; break;
                    }
                    i += 1;
                }
                continue;
            }
        }
        i += 1;
    }
    return depth;
}

// The name a chunk declares, if it declares one.
function nameOf(text) {
    let body = text;
    for (;;) {
        const before = body;
        body = body.replace(/^\s+/, '');
        body = body.replace(/^\/\/[^\n]*\n?/, '');
        body = body.replace(/^\/\*[\s\S]*?\*\//, '');
        if (body === before) break;
    }
    let m = body.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
    if (m) return { kind: 'function', name: m[1] };
    m = body.match(/^(const|let|var)\s+([A-Za-z_$][\w$]*)/);
    if (m) return { kind: m[1], name: m[2] };
    m = body.match(/^class\s+([A-Za-z_$][\w$]*)/);
    if (m) return { kind: 'class', name: m[1] };
    if (/^\S/.test(body)) return { kind: 'statement', name: null };
    return { kind: 'blank', name: null };
}

module.exports = { chunk, splitDeclarations, depthAfter, nameOf };

if (require.main === module) {
    const file = process.argv[2];
    const source = fs.readFileSync(file, 'utf8');
    const pieces = splitDeclarations(source);
    const rebuilt = pieces.map((p) => p.text).join('');
    if (rebuilt !== source) {
        console.error('ROUND TRIP FAILED');
        for (let k = 0; k < Math.max(rebuilt.length, source.length); k += 1) {
            if (rebuilt[k] !== source[k]) {
                console.error(`first difference at offset ${k}`);
                console.error('original:', JSON.stringify(source.slice(k - 80, k + 80)));
                console.error('rebuilt :', JSON.stringify(rebuilt.slice(k - 80, k + 80)));
                break;
            }
        }
        process.exit(1);
    }
    console.log(`round trip OK: ${pieces.length} top-level chunks, ${source.length} bytes`);
    pieces.forEach((p) => {
        const info = nameOf(p.text);
        console.log(`${String(p.startLine).padStart(5)}  ${info.kind.padEnd(9)} ${info.name || ''}`);
    });
}
