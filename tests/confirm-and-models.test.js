// Tests for the model list parsing added after the first round of testing found
// that Load available models came back empty, and for the confirmation dialog.

const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/providers.js");
const C = require("../src/confirm.js");

// --- The Gemini model list ---
//
// Gemini was the one provider with no model list address at all, so the button
// returned nothing before it ever made a request. Its response shape is also
// different from everyone else's.

test("gemini now has an address for its model list", () => {
    assert.ok(P.PROVIDERS.gemini.modelsPath, "without this the button can never work");
    assert.ok(P.PROVIDERS.gemini.baseUrl.includes("generativelanguage"));
});

test("the models/ prefix is stripped from gemini names", () => {
    const payload = {
        models: [
            { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
        ],
    };
    const models = P.parseModelList(payload);
    assert.strictEqual(models[0].id, "gemini-3.6-flash");
    assert.ok(!models[0].id.includes("models/"));
});

test("gemini models that cannot hold a conversation are left out", () => {
    const payload = {
        models: [
            { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
            { name: "models/imagen-3", supportedGenerationMethods: ["predict"] },
        ],
    };
    const models = P.parseModelList(payload);
    assert.strictEqual(models.length, 1);
    assert.strictEqual(models[0].id, "gemini-3.6-flash");
});

test("streaming only gemini models are kept", () => {
    const payload = {
        models: [{ name: "models/some-model", supportedGenerationMethods: ["streamGenerateContent"] }],
    };
    assert.strictEqual(P.parseModelList(payload).length, 1);
});

test("a gemini model with no method list is kept rather than silently dropped", () => {
    // Being cautious here. If the shape changes we would rather show a model than
    // hide it, since the field is typeable anyway.
    const payload = { models: [{ name: "models/mystery-model" }] };
    assert.strictEqual(P.parseModelList(payload).length, 1);
});

test("the display name is used as the label when there is one", () => {
    const payload = {
        models: [{
            name: "models/gemini-3.6-flash",
            displayName: "Gemini 3.6 Flash",
            supportedGenerationMethods: ["generateContent"],
        }],
    };
    assert.strictEqual(P.parseModelList(payload)[0].label, "Gemini 3.6 Flash");
});

test("ollama model names still work and are not treated as gemini", () => {
    // Ollama uses the same models array but without the prefix, so this checks
    // the change for Gemini did not break it.
    const models = P.parseModelList({ models: [{ name: "gemma3:12b" }] });
    assert.strictEqual(models[0].id, "gemma3:12b");
});

test("every provider that claims a model list has an address to reach it", () => {
    P.listProviders().forEach((provider) => {
        if (!provider.modelsPath) return;
        // Custom is the exception, since the reader supplies the address.
        if (provider.id === "custom") return;
        assert.ok(provider.baseUrl, `${provider.id} has a models path but no address`);
    });
});

// --- The confirmation dialog ---

test("the confirmation module is loadable and exposes ask", () => {
    assert.strictEqual(typeof C.ask, "function");
});

test("there is a tone for each level of seriousness", () => {
    ["danger", "warning", "normal"].forEach((tone) => {
        assert.ok(C.STYLES[tone], `${tone} should exist`);
        assert.ok(C.STYLES[tone].button, `${tone} needs a button style`);
        assert.ok(C.STYLES[tone].icon, `${tone} needs an icon`);
    });
});

test("the destructive tone is red, so it does not look like a normal action", () => {
    assert.ok(C.STYLES.danger.button.includes("red"));
});

test("asking falls back to a plain answer when there is no page to draw on", async () => {
    // Under Node there is no document. The important part is that it resolves to
    // false rather than throwing or quietly returning something truthy, because a
    // truthy answer would mean the delete goes ahead.
    const answer = await C.ask({ title: "x", message: "y" });
    assert.strictEqual(answer, false, "with no way to ask, the safe answer is no");
});
