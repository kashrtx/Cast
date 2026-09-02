// Getting one character's reply, from the request to the words on screen.
//
// This is the longest thing in the app and the most careful, because it is where the most can go
// wrong: the reply streams in a piece at a time, the chat can be closed or switched while it is
// still arriving, the model can stop halfway, and the request can fail after some of the text has
// already been shown.
//
// The shape to hold in your head is: work out whether this is the opening message or a continuing
// one, show the typing indicator, build the context, send, then update the same message repeatedly
// as text arrives. Every exit from that, including the failures, has to remove the indicator and
// clear the pending flag for this character, or the chat is left looking like it is still thinking.
//
// If you change anything here, the thing to check is what happens when a reply is interrupted
// rather than what happens when it works.

// The character says they cannot answer right now.
//
// Added as a real reply from them rather than as a system notice, for two reasons. It
// reads as part of the story instead of as a broken app. And the continue feature needs a
// message from each side before it will run, so a failure that left no reply behind made
// pressing enter on an empty box refuse to work as well.
//
// These are never sent to the model. They are marked so the history builders leave them
// out, otherwise the character would start treating their own outage as something that
// happened in the story.
function addCharacterUnavailableReply(chatId, character, error) {
    if (!chatId || !Array.isArray(state.chats[chatId])) return;

    const provider = getProviderConfig();
    const described = CastProviders.describeProviderError(error, provider);

    const line = CastProviders.characterUnavailableLine({
        characterName: character ? character.name : "They",
        userName: state.personalContext ? state.personalContext.name : "",
        description: `${described.short} ${described.advice}`,
    });

    state.chats[chatId].push({
        id: generateUniqueId(),
        content: line,
        isUser: false,
        characterId: character ? character.id : null,
        // Counts as a reply for the continue feature, but never goes to the model.
        isError: true,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    });

    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    recordActivity(CastLog.KINDS.REPLY_FAILED, described.short);

    if (state.activeChat === chatId) updateChatMessages();

    return described;
}

// Puts a failure into the conversation itself, in the chat it belongs to.
//
// A banner at the top of the page can be scrolled away from, covered, or simply missed.
// A bubble sits where you are already looking, and stays there, so a reply that never
// arrived leaves a visible trace of why.
function showChatError(chatId, characterId, message) {
    if (!chatId || !Array.isArray(state.chats[chatId])) return;

    state.chats[chatId].push({
        id: generateUniqueId(),
        content: message,
        isUser: false,
        isSystem: true,
        isError: true,
        characterId: characterId || null,
        timestamp: new Date().toISOString(),
        isDeleted: false,
    });

    setStoredItem(STORAGE_KEYS.CHATS, state.chats);
    recordActivity(CastLog.KINDS.REPLY_FAILED, message.slice(0, 120));

    if (state.activeChat === chatId) updateChatMessages();
}

async function getCharacterResponse(characterOrId, userMsg) {
    // Always work from the live record.
    //
    // This is what makes an edit take effect on the very next message. The object
    // passed in can be a copy taken when the chat was opened, so reading a
    // description from it could use the version from before the edit. Looking it up
    // again here means the profile sent to the model is always the current one.
    const character = getLiveCharacter(characterOrId);
    if (!character) {
        showError("That character could not be found, so no reply was requested.");
        return;
    }

    // Determine which chat this response belongs to
    const chatId = state.activeChat;

    // Track that we're generating a response for this character in this chat
    state.pendingResponses[character.id] = {
        chatId: chatId,
        isGenerating: true
    };
    let responseStatusTimer = null;

    try {
        // Get visible messages for context (excluding any that are marked as deleted)
        const visibleMessages = state.chats[chatId].filter(m => !m.isDeleted);

        // Check if this is the first message in the conversation
        const isFirstMessage = (() => {
            const characterMessages = visibleMessages.filter(m =>
                !m.isUser &&
                m.characterId === character.id &&
                !m.isSystem &&
                !m.isTyping
            );
            return characterMessages.length === 0;
        })();

        // Check if this is a continue message
        const isContinue = userMsg && userMsg.isContinue === true;

        // Add typing indicator for better UX
        const typingMsg = {
            id: generateUniqueId(),
            content: "",
            isUser: false,
            characterId: character.id,
            timestamp: new Date().toISOString(),
            isTyping: true,
            isDeleted: false
        };

        // Add the typing indicator
        addMessage(typingMsg);
        responseStatusTimer = startResponseStatusUpdates(typingMsg.id, character);

        // Simulate a minimal typing delay based on character and context
        // This makes the interaction feel more natural
        const minTypingDelay = 500; // base minimum delay

        // Calculate a more natural variable typing delay based on message complexity
        // Consider character complexity, previous message length, and a bit of randomness
        const baseDelay = Math.max(minTypingDelay, Math.min(2000, visibleMessages.length * 100));
        const randomVariation = Math.floor(Math.random() * 800) - 400; // -400 to +400ms variation
        const typingDelay = Math.max(minTypingDelay, baseDelay + randomVariation);

        await new Promise(resolve => setTimeout(resolve, typingDelay));

        let promptContext;

        if (isFirstMessage && !isContinue) {
            // For the first message, we include the full character context
            console.log("First message in conversation, using full character context");
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                getChatCharacters(chatId) // the characters actually in this chat
            );

            try {
                // Use a simpler approach for the first message
                const result = await callGeminiAPI(promptContext, { includeMetadata: true });
                const firstReply = typeof result === 'string' ? result : result.reply;
                const firstReasoning = typeof result === 'object' && result
                    ? String(result.reasoning || '').trim()
                    : '';

                // Check if we're still generating a response for this character
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Remove typing indicator
                    removeTypingIndicator(typingMsg.id);

                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: firstReply,
                        reasoning: firstReasoning,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
            } catch (error) {
                // Make sure to remove typing indicator even on error
                removeTypingIndicator(typingMsg.id);
                throw error; // Re-throw to be caught by outer try-catch
            }

            return;
        }

        // For subsequent messages, use the conversation history approach with Gemini Chat
        console.log("Using chat history approach for response");

        // Convert visible history for the model.
        //
        // Compaction happens here and nowhere else, so there is exactly one place
        // where what gets sent is decided. If the setting is off, or nothing has
        // been summarised yet, this behaves exactly as it did before.
        const memoryForChat = getChatMemory(chatId);
        const plan = CastMemory.buildSendableHistory({
            messages: visibleMessages,
            memory: memoryForChat,
            settings: appSettings.memory,
            enabled: Boolean(appSettings.memoryCompaction),
        });

        if (plan.recovered) {
            // The summary no longer lines up with the messages, usually because some
            // were deleted. Throw it away and start again rather than send a
            // fragment.
            console.warn("The stored summary no longer matches this chat, so it has been cleared and the full conversation is being sent.");
            clearChatMemory(chatId);
        }

        const history = convertHistoryForGemini(plan.messages, character);

        // Held until the character's instructions have been built further down,
        // since that variable does not exist yet at this point.
        const summaryPreamble = (plan.compacted && plan.summary)
            ? CastMemory.formatSummaryForPrompt(plan.summary, character.name)
            : "";

        // Log the history for debugging
        if (window.debugApp) {
            console.log("History being sent to API:", JSON.stringify(history));
        }

        // Check if history is valid
        if (history.length === 0) {
            console.warn("Empty history after conversion, falling back to basic prompt");
            // Remove typing indicator
            removeTypingIndicator(typingMsg.id);

            // Create a basic prompt instead
            promptContext = prepareContextForAPI(
                character,
                visibleMessages,
                getChatCharacters(chatId) // the characters actually in this chat
            );

            try {
                // Use a simpler approach as fallback
                const result = await callGeminiAPI(promptContext);

                // Only add the response if we're still responding to the same chat
                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    // Add the response as a message
                    addMessage({
                        id: generateUniqueId(),
                        content: result,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }
                return;
            } catch (error) {
                throw new Error("Failed to get response with fallback method: " + error.message);
            }
        }

        // There used to be a block here building an instruction such as "Remember that
        // you are roleplaying as X", which was then sent as the turn. That is why a
        // character could answer the instruction instead of the reader. The character
        // profile is a system instruction now, so no reminder needs sending at all.

        // What actually gets sent as this turn.
        //
        // For an ordinary message this is exactly what the reader typed. The reminder
        // about staying in character now lives in the system instruction, where it
        // belongs, instead of being sent as though the reader had said it.
        let outgoingMessage = "";

        if (userMsg.isInitializing) {
            outgoingMessage = `Introduce yourself briefly, in a way true to your character. Keep it to one or two short paragraphs and leave room for a reply. Do not use my name unless I have already told you it.`;
        } else if (isContinue) {
            // There is no reader message to send, so a nudge is unavoidable here. It is
            // written as a stage direction rather than as speech, so the character has
            // nothing to reply to.
            outgoingMessage = `[Continue the scene yourself, carrying on from your last message. Do not mention this note.]`;
        } else {
            outgoingMessage = String(userMsg.content || "").trim();
            // A blank ordinary message should never reach this point, but if it does,
            // treat it the same as a continue rather than sending nothing at all.
            if (!outgoingMessage) {
                outgoingMessage = `[Continue the scene yourself, carrying on from your last message. Do not mention this note.]`;
            }
        }

        // There used to be a line here appending an instruction that asked the
        // model not to think. It has been removed. A prompt cannot switch off a
        // reasoning pass, so it never worked, and it pushed meta instructions
        // into the character's persona where they did not belong. Reasoning is
        // now kept short through the API's own settings and separated from the
        // reply after it arrives.

        try {
            await ensureAIProviderReady();

            if (getProviderConfig().kind !== CastProviders.KIND.GEMINI) {
                updateTypingIndicatorStatus(typingMsg.id, `${getProviderDisplayName()} is writing...`);

                // The reader's newest message is sent as the final turn, so it must not
                // also appear in the history or the model sees it twice.
                const historyWithoutLatestLocal = history.length && !userMsg.isInitializing
                    ? history.slice(0, -1)
                    : history;
                const localMessages = buildLocalChatMessages(character, historyWithoutLatestLocal, outgoingMessage);
                // callAIChat now separates reasoning from the reply and refuses a
                // response that is nothing but reasoning, so anything that comes
                // back here is real reply text.
                const localResult = await callAIChat(
                    localMessages,
                    getConversationTokenLimit(),
                    { includeMetadata: true }
                );
                // Test doubles and older extensions may still return a string.
                const localResponse = typeof localResult === 'string' ? localResult : localResult.reply;
                const localReasoning = typeof localResult === 'object' && localResult
                    ? String(localResult.reasoning || '').trim()
                    : '';

                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    removeTypingIndicator(typingMsg.id);
                    addMessage({
                        id: generateUniqueId(),
                        content: localResponse,
                        reasoning: localReasoning,
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isDeleted: false,
                    });
                }

                console.log(`${getProviderDisplayName()} reply complete, ${localResponse.length} characters.`);

                maybeCompactChat(chatId, character).catch(error => {
                    console.warn("Summarising after the reply did not work:", error);
                });
                return;
            }
            // Create a chat with the history using the Gemini SDK.
            const modelName = getModelFor("gemini");
            const generationConfig = CastProviders.buildGeminiConfig({
                model: modelName,
                maxTokens: getConversationTokenLimit(),
                temperature: appSettings.temperature,
            });

            // The character's whole profile goes in as a system instruction.
            //
            // This is the fix for a character seeming to lose the thread. Before, the
            // profile was only sent on the very first message, and every turn after
            // that ended by sending a reminder as though the reader had typed it. So
            // the model saw the reader's message, then a separate turn saying
            // "Remember that you are roleplaying as X", and it answered the reminder
            // instead of the reader. With a short message like "ok" the reminder was
            // the most substantial thing in front of it, which is why the reply came
            // back explaining who the character was rather than responding.
            //
            // The profile now sits where instructions belong, and the message sent is
            // what the reader actually wrote.
            generationConfig.systemInstruction = prepareContextForAPI(
                character,
                [],
                getChatCharacters(chatId)
            );
            if (summaryPreamble) {
                generationConfig.systemInstruction += `\n\n${summaryPreamble}`;
            }

            console.log("Creating Gemini chat with model:", modelName);

            // The reader's newest message is sent separately, so it must not also be
            // in the history or the model would see it twice.
            const historyWithoutLatest = history.length && !userMsg.isInitializing
                ? history.slice(0, -1)
                : history;

            const chat = state.genaiClient.chats.create({
                model: modelName,
                history: historyWithoutLatest,
                config: generationConfig,
            });

            // Prepare for the new response, but do not create a blank bubble before text arrives.
            let fullResponse = "";
            let responseMsg = null;
            // Determine typing speed based on character personality
            // This makes characters with verbose personalities type slower than terse ones
            const baseCharSpeed = character.enhancedContext ?
                (character.enhancedContext.includes("talkative") ||
                    character.enhancedContext.includes("verbose") ? 30 : 50) : 40;

            // Track the last update time for natural typing simulation
            let lastUpdateTime = Date.now();
            // let accumulatedText = ""; // Replaced by accumulatedRawResponse for clarity
            let accumulatedRawResponse = ""; // Accumulates raw text for final state update & processing

            // Function to simulate natural typing behavior - RETHINKING THIS
            // The main streaming loop will call updateMessageContent directly.
            // We don't strictly need updateWithTypingEffect anymore if logic is in the main loop.

            try {
                console.log("Sending message stream...");
                const result = await chat.sendMessageStream({ message: outgoingMessage });

                // Reasoning is filtered as the stream arrives. The filter holds
                // back anything that might turn out to be the start of a tag, so
                // a tag split across two chunks can never leak into the bubble.
                // That was the cause of the reasoning showing up mid reply.
                const reasoningFilter = CastThinking.createStreamFilter();
                let separateReasoning = "";
                let sawTruncation = false;

                for await (const chunk of result) {
                    if (!state.pendingResponses[character.id] || state.pendingResponses[character.id].chatId !== chatId) {
                        break; // The reader moved to a different chat.
                    }

                    // Read the chunk properly rather than trusting a combined
                    // text field. On Gemini, parts flagged as thoughts are
                    // reasoning, and the combined field can include them.
                    const piece = CastThinking.readChunk(chunk);
                    separateReasoning += piece.reasoningText || "";
                    if (piece.finishReason) {
                        const reason = piece.finishReason.toUpperCase();
                        if (reason === "MAX_TOKENS" || reason === "LENGTH") sawTruncation = true;
                    }
                    if (!piece.replyText && !piece.reasoningText) continue;

                    // Anything the provider already told us is reasoning is set
                    // aside without ever going near the bubble.
                    const visible = reasoningFilter.consume(piece.replyText);
                    if (!visible) continue;

                    // The bubble is only created once there is real reply text to
                    // put in it, so a response that is all reasoning never leaves
                    // an empty bubble behind.
                    if (!responseMsg) {
                        removeTypingIndicator(typingMsg.id);
                        responseMsg = {
                            id: generateUniqueId(),
                            content: "",
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false,
                        };
                        addMessage(responseMsg);
                    }

                    updateMessageContent(responseMsg.id, visible, false);
                    accumulatedRawResponse += visible;
                    fullResponse = accumulatedRawResponse;
                }

                const streamResult = reasoningFilter.finish();
                if (streamResult.tail && responseMsg) {
                    updateMessageContent(responseMsg.id, streamResult.tail, false);
                    accumulatedRawResponse += streamResult.tail;
                }

                if (state.pendingResponses[character.id] && state.pendingResponses[character.id].chatId === chatId) {
                    const verdict = CastThinking.verifyReply({
                        reply: accumulatedRawResponse,
                        reasoning: separateReasoning + streamResult.reasoning,
                        truncated: sawTruncation,
                        endedInsideReasoning: streamResult.endedInsideReasoning,
                    });

                    if (verdict.ok) {
                        const finalMessageInState = (state.chats[chatId] || []).find(m => m.id === responseMsg.id);
                        if (finalMessageInState) {
                            finalMessageInState.content = verdict.reply;
                            finalMessageInState.reasoning = (separateReasoning + streamResult.reasoning).trim();
                            setStoredItem(STORAGE_KEYS.CHATS, state.chats);
                        }
                        updateMessageContent(responseMsg.id, verdict.reply, true);
                    } else {
                        // The model reasoned and never got to a reply. Rather than
                        // save the reasoning as though the character had said it,
                        // remove the empty bubble and explain what happened.
                        if (responseMsg) {
                            deleteMessagePermanently(chatId, responseMsg.id);
                            responseMsg = null;
                        }
                        removeTypingIndicator(typingMsg.id);
                        showError(verdict.message);
                        if (streamResult.reasoning) {
                            console.log("The model produced only reasoning:", streamResult.reasoning.substring(0, 200));
                        }
                    }
                }
                console.log("Reply complete,", accumulatedRawResponse.length, "characters. Reasoning set aside:", streamResult.reasoning.length, "characters.");

                // Now that the reader has their reply, consider summarising the
                // older part of this chat. Deliberately after delivery, so it can
                // never make a message slower or interfere with one.
                maybeCompactChat(chatId, character).catch(error => {
                    console.warn("Summarising after the reply did not work:", error);
                });
            } catch (error) {
                console.error("Stream error:", error);
                // If streaming fails, try to process and display what was received, or an error message.
                if (state.pendingResponses[character.id] &&
                    state.pendingResponses[character.id].chatId === chatId) {

                    if (fullResponse.length < 10) {
                        // If we've barely started, try to get at least something to display
                        try {
                            const emergencyResponse = await callGeminiAPI(
                                `As ${character.name}, please respond to: "${userMsg.content || 'Continue the conversation'}" (Keep it brief and in character)`
                            );
                            if (!responseMsg) {
                                removeTypingIndicator(typingMsg.id);
                                addMessage({
                                    id: generateUniqueId(),
                                    content: emergencyResponse,
                                    isUser: false,
                                    characterId: character.id,
                                    timestamp: new Date().toISOString(),
                                    isDeleted: false,
                                });
                            } else {
                                updateMessageContent(responseMsg.id, emergencyResponse, true);
                            }
                            // The recovery produced a real reply. Do not continue
                            // into the failure handler and append an outage message
                            // after a successful answer.
                            return;
                        } catch (fallbackError) {
                            // Let the common failure path add one clear, durable
                            // explanation in the originating conversation.
                            throw fallbackError;
                        }
                    }
                }
                throw error; // Still throw the error for the outer catch block
            }
        } catch (error) {
            // Only handle specific API errors if this response is still relevant
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {

                if (error.message && error.message.includes('First content should be with role')) {
                    console.error("History format error:", error.message);

                    // Try a simplified approach
                    removeTypingIndicator(typingMsg.id);

                    // Add a system message
                    addMessage({
                        id: generateUniqueId(),
                        content: "Trying a different approach to get a response...",
                        isUser: false,
                        isSystem: true,
                        timestamp: new Date().toISOString(),
                        isDeleted: false
                    });

                    // Create a new empty typing indicator
                    const newTypingMsg = {
                        id: generateUniqueId(),
                        content: "",
                        isUser: false,
                        characterId: character.id,
                        timestamp: new Date().toISOString(),
                        isTyping: true,
                        isDeleted: false
                    };

                    // Add it
                    addMessage(newTypingMsg);

                    // Small delay
                    await new Promise(resolve => setTimeout(resolve, 500));

                    try {
                        // Try a direct prompt approach instead
                        const promptContext = prepareContextForAPI(
                            character,
                            visibleMessages.slice(-5), // Use only the last 5 messages to reduce context
                            getChatCharacters(chatId)
                        );

                        const result = await callGeminiAPI(promptContext + `\nRespond as ${character.name} to the last message from the user: "${userMsg.content || 'Continue the conversation naturally'}"`);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        // Add response
                        addMessage({
                            id: generateUniqueId(),
                            content: result,
                            isUser: false,
                            characterId: character.id,
                            timestamp: new Date().toISOString(),
                            isDeleted: false
                        });

                        return;
                    } catch (fallbackError) {
                        console.error("Fallback attempt also failed:", fallbackError);

                        // Remove typing indicator
                        removeTypingIndicator(newTypingMsg.id);

                        throw fallbackError;
                    }
                } else {
                    console.error("API error:", error);
                    // The caller captured the originating chat before navigation
                    // could change state.activeChat and owns visible reporting.
                    throw error;
                }
            }
        } finally {
            clearResponseStatusUpdates(responseStatusTimer);

            // Take the typing indicator away, whichever way we got here.
            //
            // This used to be done only on the paths that succeeded, and in the outer catch. The
            // branch just above handles a failure by reporting it and returning normally rather than
            // rethrowing, so neither of those ran: the indicator stayed in the chat for good. If you
            // had switched to another character in the meantime you would not even see it happen, and
            // going back to that conversation showed it still apparently thinking, forever, with
            // nothing that would clear it short of reloading.
            //
            // Removing an indicator that has already gone does nothing, so this is safe to call on
            // every exit rather than only on the ones that need it.
            try {
                if (typingMsg && typingMsg.id) removeTypingIndicator(typingMsg.id);
            } catch (cleanupError) {
                console.warn("The typing indicator could not be removed:", cleanupError);
            }

            // Clean up the pending response status when done
            if (state.pendingResponses[character.id] &&
                state.pendingResponses[character.id].chatId === chatId) {
                state.pendingResponses[character.id].isGenerating = false;
            }
        }
    } catch (error) {
        clearResponseStatusUpdates(responseStatusTimer);
        console.error("Error in getCharacterResponse:", error);

        if (state.pendingResponses[character.id] &&
            state.pendingResponses[character.id].chatId === chatId) {
            state.pendingResponses[character.id].isGenerating = false;
        }

        // Tidy up anything left mid flight, so a failure does not leave a typing
        // indicator spinning forever.
        try { removeTypingIndicator(typingMsg && typingMsg.id); } catch (cleanupError) { /* nothing useful to do */ }

        // Handed back to the caller.
        //
        // This used to be swallowed here. The error was logged and then the function
        // returned as though nothing had happened, so the code that reports a failure to
        // you never ran. That is why a rate limit produced complete silence: it was
        // caught, written to the console, and dropped.
        throw error;
    }
}
