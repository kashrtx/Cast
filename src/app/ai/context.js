// Building what the model actually receives.
//
// A reply is only as good as what was sent, and what gets sent is assembled here: the character's
// profile, what you told the app about yourself, the guidance on staying in character, and as much
// of the conversation as the token budget allows.
//
// This is the most useful file in the project to read if you want to change how characters behave,
// and the easiest place to make things worse. The long text below is a prompt, not code, so treat
// an edit to it as a change anyone using the app will notice.

function convertGeminiHistoryToChatMessages(history) {
    return history.map(entry => ({
        role: entry.role === "model" ? "assistant" : "user",
        content: (entry.parts || []).map(part => part.text || "").join("\n"),
    })).filter(message => message.content.trim());
}

// Builds the message list for a provider that speaks the OpenAI shape.
//
// Note what is no longer here. The old version appended an instruction telling
// the model not to think, both to the system prompt and to the per turn
// instructions. It never worked, because reasoning is part of how a model runs
// and not something a prompt can switch off, and it leaked meta instructions
// into the character's persona. Reasoning is now handled by asking the API
// properly and by separating it from the reply when it comes back.
function buildLocalChatMessages(character, history, instructions) {
    const systemPrompt = prepareContextForAPI(character, [], [character]);
    return [
        { role: "system", content: systemPrompt },
        ...convertGeminiHistoryToChatMessages(history),
        { role: "user", content: instructions },
    ];
}

// Context preparation for chat
function prepareContextForAPI(character, chatHistory, activeCharacters = []) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.conversationTokens * 0.75);

    // Base context with character information and roleplay instructions
    let context = `You are ${character.name}. You must maintain your character's personality and traits at all times.

CHARACTER PROFILE:
${character.enhancedContext
            ? character.enhancedContext
            : character.userContext}

${state.personalContext.name || state.personalContext.personality || state.personalContext.context ? `ABOUT THE PERSON YOU ARE TALKING TO:
${state.personalContext.name ? `Their name is ${state.personalContext.name}. Always use their name when appropriate.` : ''}
${state.personalContext.personality ? `\nTheir personality: ${state.personalContext.personality}` : ''}
${state.personalContext.context ? `\nAdditional context about them: ${state.personalContext.context}` : ''}\n` : ''}

ROLEPLAY GUIDELINES:
- Stay in character at all times - you ARE ${character.name}
- Never break character or mention being an AI
- Do not output visible thinking, chain-of-thought, or <think> sections; reply directly and fully in character
- Respond naturally based on your character's personality and the user's known traits
- Use natural conversational language and emotional responses
- If the user has shared their name or traits, incorporate these naturally into your responses
- For empty messages (continue), advance the conversation naturally while staying in character
- Maintain continuity with previous messages and scene
- Use *single asterisks* for actions, gestures and thoughts, and **double asterisks** to stress a word. This is ordinary markdown, which is what you already write naturally.
- Put each action on its own line, with a blank line around it, so it reads separately from speech.
- Use ## on its own line for a change of scene.
- You can read text in brackets as thoughts or context.
- If the user wants to end the conversation/roleplay by saying e.g. "The End", you can say naturally to your character "Goodbye!" or "It was nice talking to you!" or "It was fun roleplaying with you!"`;

    // Add conversation history with smart context management
    if (chatHistory.length > 0) {
        const relevantMessages = chatHistory.filter(msg => !msg.isDeleted && !msg.isTyping);

        if (relevantMessages.length > 0) {
            // Always include the first exchange to maintain the conversation's origin
            const firstExchange = relevantMessages.slice(0, 2);

            // Get the most recent messages
            const recentMessages = relevantMessages.slice(-5);

            // If we have a long conversation, add a summary of key points
            if (relevantMessages.length > 7) {
                // Add first exchange
                context += "\n\nCONVERSATION START:\n" + firstExchange.map(msg => {
                    if (msg.isUser) {
                        return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                    } else if (msg.characterId === character.id) {
                        return `${character.name}: ${msg.content}`;
                    }
                }).join('\n');

                // Add a transition
                context += "\n\n[Several messages exchanged, maintaining the conversation's flow and themes...]\n\n";
            }

            // Add recent messages
            context += "RECENT CONVERSATION:\n" + recentMessages.map(msg => {
                if (msg.isUser) {
                    return `${state.personalContext.name ? state.personalContext.name : "User"}: ${msg.content}`;
                } else if (msg.characterId === character.id) {
                    return `${character.name}: ${msg.content}`;
                } else {
                    const msgCharacter = state.characters.find(c => c.id === msg.characterId);
                    return msgCharacter ? `${msgCharacter.name}: ${msg.content}` : `Unknown: ${msg.content}`;
                }
            }).join('\n');
        }
    }

    return context;
}

// Convert history to the format expected by Gemini API
function convertHistoryForGemini(chatHistory, currentCharacter) {
    const formattedHistory = [];
    let hasUserMessage = false;

    // First, check if there's at least one user message in the history
    for (const msg of chatHistory) {
        if (msg.isUser && !msg.isDeleted && !msg.isContinue) {
            hasUserMessage = true;
            break;
        }
    }

    // If no user messages, create a natural conversation starter
    if (!hasUserMessage) {
        const greeting = state.personalContext.name
            ? `Hello ${state.personalContext.name}`
            : "Hello";

        formattedHistory.push({
            role: "user",
            parts: [{ text: greeting }]
        });
        return formattedHistory;
    }

    // Filter relevant messages
    const relevantMessages = chatHistory.filter(msg => {
        if (msg.isTyping || (msg.isDeleted && !msg.isContinue)) return false;
        if (msg.isContinue) return false;
        // A note saying the character was unavailable is not something they said in the
        // story, so it must not be sent back to them as though it were.
        if (msg.isError) return false;
        return msg.isUser || msg.characterId === currentCharacter.id || msg.characterId;
    });

    // Process messages
    let lastRole = null;
    let combinedUserMessage = "";

    for (let i = 0; i < relevantMessages.length; i++) {
        const msg = relevantMessages[i];

        if (msg.isUser) {
            if (lastRole === "user" && combinedUserMessage) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = msg.content;
            } else {
                combinedUserMessage = msg.content;
                lastRole = "user";
            }

            if (i === relevantMessages.length - 1 || !relevantMessages[i + 1].isUser) {
                formattedHistory.push({
                    role: "user",
                    parts: [{ text: combinedUserMessage }]
                });
                combinedUserMessage = "";
            }
        } else if (msg.characterId === currentCharacter.id) {
            formattedHistory.push({
                role: "model",
                parts: [{ text: msg.content }]
            });
            lastRole = "model";
            combinedUserMessage = "";
        } else if (msg.characterId) {
            const otherCharacter = state.characters.find(c => c.id === msg.characterId);
            const characterName = otherCharacter ? otherCharacter.name : "Another character";
            formattedHistory.push({
                role: "user",
                parts: [{ text: `[${characterName}] ${msg.content}` }]
            });
            lastRole = "user";
            combinedUserMessage = "";
        }
    }

    // Ensure history ends with user message if needed
    if (formattedHistory.length > 0 && formattedHistory[formattedHistory.length - 1].role === "model") {
        formattedHistory.push({
            role: "user",
            parts: [{
                text: state.personalContext.name
                    ? `(${state.personalContext.name} continues listening)`
                    : "(continue the conversation)"
            }]
        });
    }

    return formattedHistory; // fixed bug: Error getting character response: TypeError: Assignment to constant variable. at convertHistoryForGemini
    // Error sending message: ReferenceError: typingMsg is not defined at getCharacterResponse
}
