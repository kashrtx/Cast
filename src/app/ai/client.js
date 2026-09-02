// Asking a model for a reply.
//
// This used to be three providers with a separate function each. Everything that speaks the OpenAI
// chat format now shares one path, and a provider is a row in the registry in src/providers.js
// rather than new code here. Ollama keeps a second path because it does not follow that format.
//
// Above those sit callAIText and callAIChat, which is what the rest of the app calls. They connect
// if needed, send, and hand back a finished reply with any reasoning already separated out by
// src/thinking.js.

async function callOpenAiCompatible(messages, maxOutputTokens, providerId) {
    const provider = getProviderConfig(providerId);
    const baseUrl = getBaseUrlFor(provider.id);
    let model = getModelFor(provider.id);

    // LM Studio often runs with a single loaded model and people leave the name
    // as the placeholder, so ask the server what it has.
    if (provider.id === "lmstudio" && (!model || model === "local-model")) {
        model = await resolveModelFromServer(provider.id) || model;
    }

    const response = await fetchProvider(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: CastProviders.buildHeaders(provider, getApiKeyFor(provider.id)),
        body: JSON.stringify(CastProviders.buildChatBody({
            model,
            messages,
            maxTokens: getTokenLimit(maxOutputTokens),
            temperature: appSettings.temperature,
            stream: false,
        })),
    }, provider.id);

    if (!response.ok) {
        const body = await readErrorBody(response);

        // If this went through the proxy, the failure may be the proxy rather than the provider.
        if (response.viaProxy || lastRequestUsedProxy) {
            const proxyProblem = describeProxyFailure(response, body, getProxyUrl());
            if (proxyProblem) {
                recordActivityIfReady(CastLog.KINDS.PROXY_FAILED, proxyProblem);
                throw new Error(proxyProblem);
            }
        }

        throw new Error(describeProviderFailure(response.status, body, provider));
    }

    const payload = await response.json();
    // Reasoning and reply are separated here, for every provider, in one place.
    return CastThinking.extractFromResponse(payload);
}

// Ollama's own endpoint. Kept because its response shape and generation options
// differ from the OpenAI-compatible endpoint.
async function callOllamaNative(messages, maxOutputTokens) {
    const provider = getProviderConfig("ollama");
    const baseUrl = getBaseUrlFor("ollama");

    const response = await fetchProvider(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: getModelFor("ollama"),
            messages,
            stream: false,
            options: {
                temperature: appSettings.temperature,
                num_predict: getTokenLimit(maxOutputTokens),
            },
        }),
    }, "ollama");

    if (!response.ok) {
        throw new Error(CastProviders.describeFailure(response.status, await readErrorBody(response), provider));
    }

    return CastThinking.extractFromResponse(await response.json());
}

// Asks a provider what models it currently has. Used to fill the suggestion list
// under the model field, so the suggestions are the real catalogue of the day
// rather than a list baked in when this was written.
async function fetchModelSuggestions(providerId, options) {
    const provider = getProviderConfig(providerId);
    if (!provider.modelsPath) {
        throw new Error(`${provider.label} does not publish a model list. Type a name from their website.`);
    }

    const baseUrl = getBaseUrlFor(provider.id);
    if (!baseUrl) {
        throw new Error(`Set the ${provider.label} address first.`);
    }

    if (provider.needsKey && !getApiKeyFor(provider.id)) {
        throw new Error(`Add your ${provider.label} key first, then the list can be loaded.`);
    }

    let url = `${baseUrl}${provider.modelsPath}`;
    const headers = CastProviders.buildHeaders(provider, getApiKeyFor(provider.id));

    // Gemini wants the key in the query string, not a header, and sending an
    // Authorization header to it causes the request to be rejected.
    if (provider.kind === CastProviders.KIND.GEMINI) {
        url += `?key=${encodeURIComponent(getApiKeyFor("gemini"))}&pageSize=200`;
        delete headers.Authorization;
    }

    const response = await fetchProvider(url, { headers }, provider.id);

    if (!response.ok) {
        const body = await readErrorBody(response);
        if (lastRequestUsedProxy) {
            const proxyProblem = describeProxyFailure(response, body, getProxyUrl());
            if (proxyProblem) {
                recordActivityIfReady(CastLog.KINDS.PROXY_FAILED, proxyProblem);
                throw new Error(proxyProblem);
            }
        }
        throw new Error(describeProviderFailure(response.status, body, provider));
    }

    const payload = await response.json();
    const freeOnly = Boolean(options && options.freeOnly) && provider.supportsFreeFilter;
    const models = CastProviders.parseModelList(payload, { freeOnly });

    if (!models.length) {
        throw new Error(`${provider.label} replied but listed no usable chat models. Type a name from their website.`);
    }

    return models;
}

async function resolveModelFromServer(providerId) {
    try {
        const models = await fetchModelSuggestions(providerId);
        return models.length ? models[0].id : "";
    } catch (error) {
        return "";
    }
}

async function initializeAIProvider({ showErrors = true } = {}) {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);

    if (!isProviderConfigured(providerId)) {
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(getProviderConfigurationMessage(providerId));
        return false;
    }

    try {
        if (provider.kind === CastProviders.KIND.GEMINI) {
            const { GoogleGenAI } = await import("https://esm.run/@google/genai");
            state.genaiClient = new GoogleGenAI({ apiKey: getApiKeyFor("gemini") });

            const result = await state.genaiClient.models.generateContent({
                model: getModelFor("gemini"),
                contents: "Reply with OK.",
                config: CastProviders.buildGeminiConfig({
                    model: getModelFor("gemini"),
                    maxTokens: 256,
                    temperature: appSettings.temperature,
                }),
            });
            const checked = CastThinking.extractFromResponse(result);
            console.log("Gemini reachable. Test reply:", checked.reply.substring(0, 40));
        } else {
            state.genaiClient = null;
            const probe = [{ role: "user", content: "Reply with OK." }];
            if (provider.kind === CastProviders.KIND.OLLAMA) {
                await callOllamaNative(probe, 256);
            } else {
                await callOpenAiCompatible(probe, 256, provider.id);
            }
            console.log(`${provider.label} reachable.`);
        }

        state.activeProvider = providerId;
        state.isApiConnected = true;
        checkApiKey();
        return true;
    } catch (error) {
        console.error(`Could not connect to ${provider.label}:`, error);
        state.isApiConnected = false;
        state.activeProvider = null;
        if (showErrors) showError(error.message);
        checkApiKey();
        return false;
    }
}

// Older call sites used this name.
async function initializeGeminiAPI(options) {
    return initializeAIProvider(options);
}

async function ensureAIProviderReady() {
    const providerId = getCurrentProvider();
    const provider = getProviderConfig(providerId);
    const isGemini = provider.kind === CastProviders.KIND.GEMINI;

    if (state.isApiConnected && state.activeProvider === providerId && (!isGemini || state.genaiClient)) {
        return true;
    }

    // Say what is actually wrong before trying anything.
    if (!isProviderConfigured(providerId)) {
        throw new Error(getProviderConfigurationMessage(providerId));
    }

    // Everything needed is present, so reconnect without making a test request.
    //
    // This used to call the full connect routine, which sends a short test message
    // first. That doubled the number of requests per reply and meant a rate limit on
    // the test call was reported as "Finish setting up Google Gemini in Settings",
    // which sent you to a settings screen where nothing was wrong. The real request
    // below will report its own failure honestly.
    if (isGemini) {
        try {
            const { GoogleGenAI } = await import("https://esm.run/@google/genai");
            state.genaiClient = new GoogleGenAI({ apiKey: getApiKeyFor("gemini") });
        } catch (error) {
            throw new Error(`Could not load the Google library: ${error.message}`);
        }
    } else {
        state.genaiClient = null;
    }

    state.activeProvider = providerId;
    state.isApiConnected = true;
    checkApiKey();
    return true;
}

// A single prompt with no conversation around it, used for character context
// enhancement and for the fallback path.
async function callAIText(prompt, maxOutputTokens, options) {
    await ensureAIProviderReady();

    const provider = getProviderConfig();

    if (provider.kind === CastProviders.KIND.GEMINI) {
        const result = await state.genaiClient.models.generateContent({
            model: getModelFor("gemini"),
            contents: prompt,
            config: CastProviders.buildGeminiConfig({
                model: getModelFor("gemini"),
                maxTokens: getTokenLimit(maxOutputTokens),
                temperature: appSettings.temperature,
            }),
        });
        return finishReply(CastThinking.extractFromResponse(result), options);
    }

    const messages = [{ role: "user", content: prompt }];
    if (provider.kind === CastProviders.KIND.OLLAMA) {
        return finishReply(await callOllamaNative(messages, maxOutputTokens), options);
    }
    return finishReply(await callOpenAiCompatible(messages, maxOutputTokens, provider.id), options);
}

// A full conversation.
async function callAIChat(messages, maxOutputTokens, options) {
    await ensureAIProviderReady();

    const provider = getProviderConfig();

    if (provider.kind === CastProviders.KIND.OLLAMA) {
        return finishReply(await callOllamaNative(messages, maxOutputTokens), options);
    }
    if (provider.kind === CastProviders.KIND.GEMINI) {
        const flattened = messages
            .map(message => `${String(message.role).toUpperCase()}: ${message.content}`)
            .join("\n\n");
        return callAIText(flattened, maxOutputTokens, options);
    }
    return finishReply(await callOpenAiCompatible(messages, maxOutputTokens, provider.id), options);
}

// The last check before a reply is used anywhere.
//
// If the model produced only its reasoning, we refuse it rather than passing the
// reasoning off as something the character said. That is the exact failure the
// old code had, where a message could be saved containing nothing but the
// model's working out.
function finishReply(extracted, options) {
    const verdict = CastThinking.verifyReply(extracted);
    if (!verdict.ok) {
        throw new Error(verdict.message);
    }
    if (options && options.includeMetadata) {
        return { reply: verdict.reply, reasoning: String(extracted.reasoning || '').trim() };
    }
    return verdict.reply;
}

async function callGeminiText(prompt, maxOutputTokens) {
    return callAIText(prompt, maxOutputTokens);
}

// API communication
async function callGeminiAPI(prompt, options) {
    try {
        return await callAIText(
            prompt,
            appSettings.enhancedContextTokens || appSettings.maxTokens,
            options
        );
    } catch (error) {
        console.error(`${getProviderDisplayName()} API call failed:`, error);
        state.isApiConnected = false;
        checkApiKey();
        throw error;
    }
}
