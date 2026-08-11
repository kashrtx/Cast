// Turning what the model writes into what you see.
//
// What went wrong before
//
// Emphasis was handled by one regular expression that ran before the markdown
// parser:
//
//   /\*((?!\*)[^*]+)\*/g
//
// It had three faults that combined into a mess.
//
// It could not see double asterisks. Given **charming**, the lookahead blocks the
// first asterisk, so it matched the inner pair and left the outer two behind as
// strays.
//
// Its middle part, [^*]+, matches newlines. So a stray asterisk left over from the
// step above would pair with the opening asterisk of the next action line, several
// paragraphs later, italicising the narration in between and swallowing the marker
// that was supposed to start the action.
//
// And because it ran before the markdown parser, whatever it left behind got parsed
// again, so one unbalanced marker flipped italics on and off for the rest of the
// message. That is why actions came out upright and ordinary speech came out
// slanted, with stray asterisks on screen.
//
// How this works instead
//
// Emphasis is resolved here, properly, before the markdown parser sees the text, and
// the parser is left to do only what it is good at: paragraphs, lists and headings.
//
// The rules that keep it from ever cascading again:
//
//   1. Longest marker first. Double markers are matched before single ones, so
//      **bold** is never mistaken for two italics.
//   2. Emphasis never crosses a blank line. A marker that is not closed within its
//      own paragraph is not emphasis, it is a literal character.
//   3. An unmatched marker is escaped so nothing downstream can pair it with
//      anything. One stray asterisk affects one asterisk.
//   4. Text inside backticks is left completely alone.
//
// Both spellings work for each meaning, because models mix them and arguing with
// that is a waste of everyone's time. *one* and _one_ are italic, **two** and __two__
// are bold.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastMarkdown = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // Placeholders used while text is set aside so later steps cannot touch it.
    // The characters are ones that will not appear in ordinary writing.
    const HOLD_OPEN = "\u0001";
    const HOLD_CLOSE = "\u0002";

    function makeHolder(index) {
        return `${HOLD_OPEN}${index}${HOLD_CLOSE}`;
    }

    function escapeHtml(text) {
        return String(text).replace(/[&<>"']/g, (character) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[character]);
    }

    // Turns a marker into something no parser will treat as a marker.
    function neutralise(marker) {
        return marker
            .replace(/\*/g, "&#42;")
            .replace(/_/g, "&#95;");
    }

    // Is this position inside a word? Underscores between letters are usually part
    // of a name such as some_variable, not emphasis. Asterisks do not follow this
    // rule, because they are not used in words.
    function isWordCharacter(character) {
        return Boolean(character) && /[\w]/.test(character);
    }

    // Resolves emphasis within one paragraph of plain text.
    //
    // Works through the text once, keeping a small stack of markers that are open.
    // A marker only counts as emphasis if a matching one turns up later in the same
    // paragraph. Anything left open at the end is escaped.
    function resolveEmphasisInBlock(block) {
        // Find every candidate marker with its position and length.
        const markers = [];
        const pattern = /(\*{1,2}|_{1,2})/g;
        let match;

        while ((match = pattern.exec(block)) !== null) {
            const marker = match[1];
            const start = match.index;
            const before = start > 0 ? block[start - 1] : "";
            const after = block[start + marker.length] || "";

            // An underscore inside a word is not emphasis.
            if (marker[0] === "_" && isWordCharacter(before) && isWordCharacter(after)) {
                continue;
            }

            markers.push({ marker, start, length: marker.length });
        }

        if (!markers.length) return escapeHtml(block);

        // Decide which markers pair up.
        //
        // A marker can open if there is content after it, and can close if there is
        // content before it. Pairing is done by walking forward and matching each
        // opener with the next available closer of the same kind, which is how
        // people actually write and read it.
        const used = new Array(markers.length).fill(false);
        const pairs = [];

        for (let i = 0; i < markers.length; i += 1) {
            if (used[i]) continue;
            const opener = markers[i];

            // Nothing directly after it means it cannot open anything.
            const nextCharacter = block[opener.start + opener.length];
            if (!nextCharacter || /\s/.test(nextCharacter)) continue;

            for (let j = i + 1; j < markers.length; j += 1) {
                if (used[j]) continue;
                const closer = markers[j];
                if (closer.marker !== opener.marker) continue;

                // A closer needs something before it that is not a space.
                const previousCharacter = block[closer.start - 1];
                if (!previousCharacter || /\s/.test(previousCharacter)) continue;

                // And there has to be something between them.
                if (closer.start <= opener.start + opener.length) continue;

                used[i] = true;
                used[j] = true;
                pairs.push({ open: opener, close: closer, strong: opener.length === 2 });
                break;
            }
        }

        // Rebuild the text, inserting tags where pairs were found and escaping
        // everything that was not paired.
        const events = [];
        pairs.forEach((pair) => {
            events.push({ at: pair.open.start, length: pair.open.length, html: pair.strong ? "<strong>" : "<em>" });
            events.push({ at: pair.close.start, length: pair.close.length, html: pair.strong ? "</strong>" : "</em>" });
        });
        markers.forEach((marker, index) => {
            if (used[index]) return;
            events.push({ at: marker.start, length: marker.length, html: neutralise(marker.marker) });
        });

        events.sort((a, b) => a.at - b.at);

        let output = "";
        let cursor = 0;
        events.forEach((event) => {
            output += escapeHtml(block.slice(cursor, event.at));
            output += event.html;
            cursor = event.at + event.length;
        });
        output += escapeHtml(block.slice(cursor));

        return output;
    }

    // Splits text into paragraphs on blank lines and resolves each one on its own,
    // which is what stops a marker in one paragraph reaching into another.
    function resolveEmphasis(text) {
        return String(text)
            .split(/(\n[ \t]*\n)/)
            .map((piece) => (/^\n[ \t]*\n$/.test(piece) ? piece : resolveEmphasisInBlock(piece)))
            .join("");
    }

    // Sets aside anything that must not be touched: fenced code blocks and inline
    // code. Returns the text with placeholders and the list of held pieces.
    function holdCode(text) {
        const held = [];
        let output = String(text);

        output = output.replace(/```[\s\S]*?```/g, (block) => {
            held.push(block);
            return makeHolder(held.length - 1);
        });

        output = output.replace(/`[^`\n]+`/g, (span) => {
            held.push(span);
            return makeHolder(held.length - 1);
        });

        return { text: output, held };
    }

    function restoreHeld(text, held) {
        return String(text).replace(new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, "g"), (whole, index) => {
            const piece = held[Number(index)];
            return piece === undefined ? whole : piece;
        });
    }

    // Scene changes.
    //
    // Only the deliberately wrapped form, ## like this ##, becomes a scene band with
    // rules above and below it. A plain markdown heading stays a heading, because
    // that is what it looked like before and it reads better for an opening line.
    function convertScenes(text) {
        return String(text).replace(/^[ \t]*##[ \t]*(.+?)[ \t]*##[ \t]*$/gm,
            (whole, scene) => `\u0003${scene.trim()}\u0004`);
    }

    // Out of character asides.
    function convertAsides(text) {
        return String(text).replace(/\((?:OOC|ooc|OoC|p\.s\.|P\.S\.):\s*([^)]*)\)/g,
            (whole, note) => `<span class="ooc-comment">(OOC: ${note.trim()})</span>`);
    }

    // Marks up italics that look like stage directions, so they can be styled
    // differently from a word that is merely stressed.
    //
    // The test is simple and deliberately cautious: an italic run counts as an
    // action when it is long enough to be a sentence rather than a stressed word.
    function markActions(html) {
        return String(html).replace(/<em>([\s\S]*?)<\/em>/g, (whole, inner) => {
            const words = inner.trim().split(/\s+/).length;
            const looksLikeAction = words >= 4;
            return looksLikeAction
                ? `<em class="roleplay-action">${inner}</em>`
                : `<em>${inner}</em>`;
        });
    }

    // Block level structure.
    //
    // This used to be handled by the marked library. Once emphasis moved in here
    // marked was no longer needed for inline text, and removing it took headings,
    // lists, quotes and rules with it, which then showed up as literal dashes and
    // hashes. So they are handled here now.
    //
    // Note on list markers: a dash, a plus, or a number all start a list, but an
    // asterisk does not. In ordinary markdown it would, but in a roleplay a line
    // beginning with an asterisk is almost always an action, and turning
    // *She smiles.* into a bullet point would be far more annoying than not
    // supporting asterisk bullets.
    function renderBlock(rawBlock) {
        const block = rawBlock.replace(/^\n+|\n+$/g, "");
        if (!block.trim()) return "";

        const lines = block.split("\n");
        const inline = (text) => markActions(convertAsides(resolveEmphasisInBlock(text)));

        // A scene band, marked earlier with placeholder characters.
        if (/^\u0003[\s\S]*\u0004$/.test(block.trim())) {
            const scene = block.trim().slice(1, -1);
            return `<div class="scene-transition">${inline(scene)}</div>`;
        }

        // A rule.
        if (/^\s*([-*_])\1{2,}\s*$/.test(block)) {
            return "<hr>";
        }

        // A heading. This is the case that keeps the opening line looking like a
        // heading rather than a boxed caption.
        const heading = block.match(/^[ \t]*(#{1,6})[ \t]+(.+)$/);
        if (heading && lines.length === 1) {
            const level = heading[1].length;
            return `<h${level}>${inline(heading[2].trim())}</h${level}>`;
        }

        // A quote, where every line starts with an angle bracket.
        if (lines.every((line) => /^[ \t]*>/.test(line))) {
            const quoted = lines.map((line) => line.replace(/^[ \t]*>[ \t]?/, "")).join("\n");
            return `<blockquote>${inline(quoted).replace(/\n/g, "<br>")}</blockquote>`;
        }

        // A numbered list.
        if (lines.length && lines.every((line) => /^[ \t]*\d+[.)][ \t]+/.test(line) || !line.trim())) {
            const items = lines
                .filter((line) => line.trim())
                .map((line) => `<li>${inline(line.replace(/^[ \t]*\d+[.)][ \t]+/, ""))}</li>`)
                .join("");
            return `<ol>${items}</ol>`;
        }

        // A bulleted list.
        if (lines.length && lines.every((line) => /^[ \t]*[-+][ \t]+/.test(line) || !line.trim())) {
            const items = lines
                .filter((line) => line.trim())
                .map((line) => `<li>${inline(line.replace(/^[ \t]*[-+][ \t]+/, ""))}</li>`)
                .join("");
            return `<ul>${items}</ul>`;
        }

        // Anything else is a paragraph, with single newlines kept as line breaks so
        // an action on its own line stays on its own line.
        return `<p>${inline(block).replace(/\n/g, "<br>")}</p>`;
    }

    // The whole pipeline, in order.
    //
    // Returns HTML. It does not sanitise, because that belongs at the point of use
    // where DOMPurify is available. Everything from the model is escaped on the way
    // through, so the only markup in the result is markup this file created.
    function toHtml(content) {
        if (typeof content !== "string" || !content.trim()) return "";

        // 1. Set aside code so nothing below touches it.
        const withHeld = holdCode(content);

        // 2. Mark the wrapped scene form before the text is split up.
        let text = convertScenes(withHeld.text);

        // 2b. Give headings, scene bands and rules a blank line of their own.
        //
        // Models very often write a heading and then carry straight on to the next
        // line with no blank line between, which is how the opening line of a scene
        // usually arrives. Without this step that heading would be stuck in the
        // middle of a paragraph and shown as literal hash characters.
        text = text
            .replace(/^[ \t]*(#{1,6}[ \t]+.+)$/gm, "\n\n$1\n\n")
            .replace(/^[ \t]*(\u0003[\s\S]*?\u0004)[ \t]*$/gm, "\n\n$1\n\n")
            .replace(/^[ \t]*(([-*_])\2{2,})[ \t]*$/gm, "\n\n$1\n\n")
            // Collapse the runs of blank lines that the steps above can create, so
            // they do not turn into empty paragraphs.
            .replace(/\n{3,}/g, "\n\n");

        // 3. Split into blocks on blank lines and render each one on its own. This
        //    is also what stops emphasis in one paragraph reaching into another.
        const html = text
            .split(/\n[ \t]*\n/)
            .map(renderBlock)
            .filter((piece) => piece.length > 0)
            .join("\n");

        // 4. Put the code back, escaped, inside code tags.
        return restoreHeld(html, withHeld.held.map((piece) => {
            if (piece.indexOf("```") === 0) {
                const inner = piece.replace(/^```[^\n]*\n?/, "").replace(/```$/, "");
                return `<pre><code>${escapeHtml(inner)}</code></pre>`;
            }
            return `<code>${escapeHtml(piece.slice(1, -1))}</code>`;
        }));
    }

    // Used while a reply is still streaming in. The text is incomplete, so a marker
    // that has not been closed yet is normal rather than a mistake. Showing it as a
    // literal asterisk mid stream and then having it turn into italics looks like a
    // glitch, so a trailing unclosed run is simply held back until it completes.
    function toHtmlForStreaming(content) {
        if (typeof content !== "string") return "";

        // Find a trailing marker that has not been closed, and trim from there.
        const lastBlockStart = content.lastIndexOf("\n\n");
        const tail = lastBlockStart === -1 ? content : content.slice(lastBlockStart);

        const asterisks = (tail.match(/\*/g) || []).length;
        const underscores = (tail.match(/_/g) || []).length;

        let usable = content;
        if (asterisks % 2 === 1) {
            const cut = content.lastIndexOf("*");
            if (cut > -1) usable = content.slice(0, cut);
        } else if (underscores % 2 === 1) {
            const cut = content.lastIndexOf("_");
            if (cut > -1) usable = content.slice(0, cut);
        }

        return toHtml(usable);
    }

    return {
        toHtml,
        toHtmlForStreaming,
        resolveEmphasis,
        resolveEmphasisInBlock,
        convertScenes,
        convertAsides,
        markActions,
        escapeHtml,
    };
});
