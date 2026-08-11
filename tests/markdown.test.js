// Tests for turning a reply into what you see.
//
// The first group uses the exact message that came out wrong, taken from a real
// chat. If those pass, the specific bug is gone.

const test = require("node:test");
const assert = require("node:assert");
const MD = require("../src/markdown.js");

// The real message, copied as it arrived.
const REAL_MESSAGE = `*Hooou~?* 

*I draw out the sound with a theatrical gasp, placing a hand dramatically over my chest as if deeply moved by your words.*

Support for Subaru and dear Emilia-sama? Aaaah, how utterly **charming**! Such devotion to your friends is a truly rare and marvelous trait, my dear Kash~! 

*I glide a few steps closer, my movements unnaturally smooth, the hem of my jester-like coat fanning out before I pause, eyeing you with a sly, knowing smile.*

You ask what you can do to earn a place here? Well, running an estate of this grand scale requires a... *tremendous* amount of dedication. If you wish to stay under my roof and lend your strength to Emilia-sama's royal campaign, you must prove yourself useful!

*I count off options on my slender, pale fingers with exaggerated taps.*

First, there is the matter of domestic duties! Sisterly perfection though they may be, dear Ram and Rem can *always* use an extra pair of hands to keep this vast manor spotless. Or perhaps... you possess a talent for magic or swordplay to aid in the mansion's defense? 

*My gaze sharpens slightly, a hint of something deeper and far more calculating gleaming in my mismatched eyes behind the clownish makeup.*

Or perhaps your greatest value lies simply in keeping Subaru's spirits high when the path ahead grows dark, hmmm? A strong heart can be a powerful weapon, after all. 

So tell me, Kash... where do your talents lie? Show me what you can offer, and I just might find a very... *special* place for you here in the Mathers household~!`;

const rendered = MD.toHtml(REAL_MESSAGE);

// Pulls the text of every element of a given tag, so assertions can be about what
// the reader sees rather than about exact markup.
function contentsOf(html, tag) {
    const found = [];
    const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
    let match;
    while ((match = pattern.exec(html)) !== null) {
        found.push(match[1].replace(/<[^>]+>/g, "").trim());
    }
    return found;
}

test("the real message leaves no stray asterisks on screen", () => {
    // This was the visible symptom: asterisks appearing in the text.
    assert.ok(!rendered.includes("*"), "no raw asterisk should survive");
    assert.ok(!rendered.includes("&#42;"), "and none should need escaping either, since all of them pair up");
});

test("charming is bold, not italic", () => {
    // It was written as **charming**, so it is emphasis, not a stage direction.
    const strong = contentsOf(rendered, "strong");
    assert.ok(strong.includes("charming"), `expected charming in bold, got ${JSON.stringify(strong)}`);

    const italics = contentsOf(rendered, "em");
    assert.ok(!italics.includes("charming"), "charming must not be italic");
});

test("the narration after charming is not italicised", () => {
    // This was the worst of it. The stray asterisk from **charming** paired with the
    // next action's opening marker, so this sentence became italic and the action
    // that followed became upright.
    const italics = contentsOf(rendered, "em");
    const wronglyItalic = italics.find((text) => text.includes("Such devotion to your friends"));
    assert.strictEqual(wronglyItalic, undefined,
        `this sentence should be ordinary text, but it was italicised as: ${wronglyItalic}`);
});

test("every action line is italic", () => {
    const italics = contentsOf(rendered, "em");
    const expected = [
        "I draw out the sound with a theatrical gasp",
        "I glide a few steps closer",
        "I count off options on my slender",
        "My gaze sharpens slightly",
    ];
    expected.forEach((fragment) => {
        const found = italics.some((text) => text.includes(fragment));
        assert.ok(found, `this action should be italic: ${fragment}`);
    });
});

test("the stressed single words are italic", () => {
    const italics = contentsOf(rendered, "em");
    ["tremendous", "always", "special", "Hooou~?"].forEach((word) => {
        assert.ok(italics.some((text) => text === word),
            `${word} should be italic on its own`);
    });
});

test("ordinary speech stays upright", () => {
    const italics = contentsOf(rendered, "em").join(" | ");
    [
        "Support for Subaru and dear Emilia-sama",
        "You ask what you can do to earn a place here",
        "First, there is the matter of domestic duties",
        "So tell me, Kash",
    ].forEach((fragment) => {
        assert.ok(!italics.includes(fragment), `this should not be italic: ${fragment}`);
    });
});

test("action lines get their own class so they can be styled apart", () => {
    assert.ok(rendered.includes('class="roleplay-action"'));
    // A single stressed word is not a stage direction.
    const plainItalics = rendered.match(/<em>tremendous<\/em>/);
    assert.ok(plainItalics, "a one word italic should not be treated as an action");
});

test("no text is lost from the real message", () => {
    const visible = rendered.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    ["Hooou", "Emilia-sama", "Ram and Rem", "Mathers household", "swordplay", "clownish makeup"]
        .forEach((fragment) => {
            assert.ok(visible.includes(fragment), `missing from the output: ${fragment}`);
        });
});

// --- The specific failure, in isolation ---

test("bold followed later by an action does not invert everything", () => {
    // This is the smallest version of the bug.
    const source = `Utterly **charming**! Such devotion.

*She steps closer.*

Ordinary speech again.`;
    const html = MD.toHtml(source);

    assert.ok(contentsOf(html, "strong").includes("charming"));
    assert.ok(!contentsOf(html, "em").join(" ").includes("Such devotion"));
    assert.ok(contentsOf(html, "em").some((t) => t.includes("She steps closer")));
    assert.ok(!contentsOf(html, "em").join(" ").includes("Ordinary speech"));
});

test("emphasis never reaches across a blank line", () => {
    const source = `An *unclosed marker here.

*And an action on its own.*`;
    const html = MD.toHtml(source);

    // The unclosed one is literal, and the closed one is italic.
    assert.ok(html.includes("&#42;"), "the unpaired marker should be neutralised");
    assert.ok(contentsOf(html, "em").some((t) => t.includes("And an action")));
});

test("one stray marker affects only itself", () => {
    const source = "A single * asterisk, then *a proper pair* and text after.";
    const html = MD.toHtml(source);
    assert.ok(contentsOf(html, "em").includes("a proper pair"));
    const visible = html.replace(/<[^>]+>/g, "");
    assert.ok(!visible.includes("text after") || true);
    assert.ok(!html.includes("<em>text after"), "the stray must not open emphasis");
});

// --- Both spellings, since models mix them ---

test("double asterisks and double underscores both mean bold", () => {
    assert.ok(contentsOf(MD.toHtml("**one**"), "strong").includes("one"));
    assert.ok(contentsOf(MD.toHtml("__two__"), "strong").includes("two"));
});

test("single asterisks and single underscores both mean italic", () => {
    assert.ok(contentsOf(MD.toHtml("*one*"), "em").includes("one"));
    assert.ok(contentsOf(MD.toHtml("_two_"), "em").includes("two"));
});

test("bold is matched before italic, so two markers are never read as one", () => {
    const html = MD.toHtml("**bold** and *italic*");
    assert.ok(contentsOf(html, "strong").includes("bold"));
    assert.ok(contentsOf(html, "em").includes("italic"));
});

test("an underscore inside a word is left alone", () => {
    const html = MD.toHtml("The file is some_variable_name in the code.");
    assert.ok(contentsOf(html, "em").length === 0, "snake case is not emphasis");
    assert.ok(html.replace(/<[^>]+>/g, "").includes("some_variable_name")
        || html.includes("&#95;"), "the underscores stay visible one way or another");
});

test("bold and italic together work", () => {
    const html = MD.toHtml("She was **very** *very* tired.");
    assert.ok(contentsOf(html, "strong").includes("very"));
    assert.ok(contentsOf(html, "em").includes("very"));
});

// --- Safety ---

test("html from the model is escaped, not run", () => {
    const html = MD.toHtml('<img src=x onerror="alert(1)"> and <b>bold</b>');
    // The point is that no tag survives as a tag. The words inside it showing up as
    // plain text is correct, since that is literally what the model wrote.
    assert.ok(!html.includes("<img"), "no image tag should get through");
    assert.ok(!html.includes("<b>"), "no bold tag should get through");
    assert.ok(html.includes("&lt;img"), "it should appear as visible text instead");
    // No attribute can escape its quotes, because the quotes are escaped too.
    assert.ok(!/onerror\s*=\s*"/.test(html), "no live attribute should survive");
});

test("a script tag inside an action is escaped", () => {
    const html = MD.toHtml("*She said <script>alert(1)</script> quietly.*");
    assert.ok(!html.includes("<script"));
    assert.ok(html.includes("&lt;script"));
});

test("an ampersand in ordinary text survives correctly", () => {
    const html = MD.toHtml("Ram & Rem arrived.");
    assert.ok(html.includes("&amp;"));
});

// --- The app's own conventions ---

test("a scene wrapped in hashes becomes a scene band", () => {
    const html = MD.toHtml("## The drawing room ##");
    assert.ok(html.includes('class="scene-transition"'));
    assert.ok(html.includes("The drawing room"));
});

test("a plain heading stays a heading", () => {
    // Deliberately different from the wrapped form. A plain markdown heading is how
    // an opening line usually arrives, and it reads better as a heading than as a
    // boxed caption. Turning it into a scene band was a regression.
    const html = MD.toHtml("## The grand drawing room of the Mathers Mansion");
    assert.ok(html.includes("<h2>"), `expected a heading, got ${html}`);
    assert.ok(!html.includes("scene-transition"));
});

test("a heading works with no blank line after it", () => {
    // This is how it actually arrives. The model writes the heading and carries
    // straight on to the next line.
    const source = `## The grand drawing room of the Mathers Mansion
*Bows extravagantly.*
Well, well, my dear friend!`;
    const html = MD.toHtml(source);

    assert.ok(html.includes("<h2>The grand drawing room of the Mathers Mansion</h2>"),
        `the heading should stand alone, got ${html}`);
    assert.ok(!html.includes("##"), "no literal hashes should remain");
    assert.ok(contentsOf(html, "em").some((t) => t.includes("Bows extravagantly")));
});

test("heading levels are respected", () => {
    assert.ok(MD.toHtml("# One").includes("<h1>"));
    assert.ok(MD.toHtml("### Three").includes("<h3>"));
});

// --- Block structure, which the markdown library used to handle ---

test("a bulleted list becomes a list", () => {
    const html = MD.toHtml("- first option\n- second option");
    assert.ok(html.includes("<ul>"));
    assert.strictEqual(contentsOf(html, "li").length, 2);
    assert.ok(!html.includes("- first"), "the dashes should be gone");
});

test("a numbered list becomes a numbered list", () => {
    const html = MD.toHtml("1. first\n2. second\n3. third");
    assert.ok(html.includes("<ol>"));
    assert.strictEqual(contentsOf(html, "li").length, 3);
});

test("a line starting with an asterisk is an action, not a bullet", () => {
    // In ordinary markdown an asterisk starts a list. In a roleplay it almost always
    // starts an action, and turning those into bullet points would be maddening.
    const html = MD.toHtml("*She smiles at him warmly.*");
    assert.ok(!html.includes("<ul>"), "this should not become a list");
    assert.ok(contentsOf(html, "em").some((t) => t.includes("She smiles at him warmly")));
});

test("a quote becomes a quote", () => {
    const html = MD.toHtml("> she whispered something");
    assert.ok(html.includes("<blockquote>"));
    assert.ok(!html.includes("&gt; she"), "the angle bracket should be gone");
});

test("three dashes become a rule", () => {
    assert.ok(MD.toHtml("---").includes("<hr>"));
});

test("emphasis works inside a list item", () => {
    const html = MD.toHtml("- she said *quietly*\n- then **loudly**");
    assert.ok(contentsOf(html, "em").includes("quietly"));
    assert.ok(contentsOf(html, "strong").includes("loudly"));
});

test("a list following a paragraph both render", () => {
    const html = MD.toHtml("Here are the options:\n\n- first\n- second");
    assert.ok(html.includes("<p>"));
    assert.ok(html.includes("<ul>"));
});

test("an out of character aside is marked as one", () => {
    const html = MD.toHtml("(OOC: taking a break now)");
    assert.ok(html.includes('class="ooc-comment"'));
});

// --- Awkward input ---

test("empty and useless input gives nothing rather than throwing", () => {
    ["", "   ", null, undefined, 42, {}].forEach((value) => {
        assert.strictEqual(typeof MD.toHtml(value), "string");
    });
});

test("a message of only asterisks does not break anything", () => {
    const html = MD.toHtml("****");
    assert.strictEqual(typeof html, "string");
});

test("inline code is left exactly as written", () => {
    const html = MD.toHtml("Use `a * b` to multiply.");
    assert.ok(html.includes("<code>"));
    assert.ok(html.includes("a * b"), "the asterisk inside code must survive untouched");
    assert.ok(!html.includes("<em>"), "code must not be turned into emphasis");
});

test("paragraphs are kept separate", () => {
    const html = MD.toHtml("First paragraph.\n\nSecond paragraph.");
    const paragraphs = contentsOf(html, "p");
    assert.strictEqual(paragraphs.length, 2);
});

test("a single newline becomes a line break", () => {
    const html = MD.toHtml("Line one.\nLine two.");
    assert.ok(html.includes("<br>"));
});

// --- Streaming ---

test("a marker that has not been closed yet is held back mid stream", () => {
    // Halfway through writing an action, the opening asterisk should not flash on
    // screen as a literal character.
    const partial = "She smiled. *She began to";
    const html = MD.toHtmlForStreaming(partial);
    assert.ok(!html.includes("&#42;"), "the incomplete marker should not be shown as an asterisk");
    assert.ok(html.includes("She smiled"));
});

test("a completed action shows normally mid stream", () => {
    const html = MD.toHtmlForStreaming("*She smiled at him.* Then she spoke.");
    assert.ok(contentsOf(html, "em").some((t) => t.includes("She smiled at him")));
});

test("streaming and finished output agree once the text is complete", () => {
    const complete = "*She smiled.* Hello there, **friend**.";
    assert.strictEqual(MD.toHtmlForStreaming(complete), MD.toHtml(complete));
});
