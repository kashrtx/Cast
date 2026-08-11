// Turning a sentence about a character into a profile.
//
// You write who someone is in a line or two, and the model fills in the speech, the history and the
// reactions. It is the fastest way to a character that holds together, and the result is ordinary
// text in the description box, so it can be edited afterwards like anything you typed yourself.

async function enhanceCharacterContext(characterId) {
    if (!isProviderConfigured()) {
        showError(getProviderConfigurationMessage());
        return;
    }

    const character = state.characters.find(c => c.id === characterId);
    if (!character) {
        showError("Character not found");
        return;
    }

    // Find the enhance button directly - don't rely on previous selectors
    const enhanceButton = document.querySelector(`#enhance-btn-${characterId}`);
    if (enhanceButton) {
        // Visually update the button
        enhanceButton.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> Enhancing...';
        enhanceButton.disabled = true;
    } else {
        console.warn(`Enhance button for character ${characterId} not found`);
    }

    // Ensure API is initialized
    if (!state.isApiConnected) {
        try {
            const initialized = await initializeGeminiAPI();
            if (!initialized) {
                showError(`Failed to connect to ${getProviderDisplayName()}. Please check your provider settings.`);
                resetEnhanceButton(enhanceButton);
                return;
            }
        } catch (error) {
            showError(`API initialization failed: ${error.message}`);
            resetEnhanceButton(enhanceButton);
            return;
        }
    }

    // Call API
    try {
        const enhancedContext = await callEnhanceAPI(character.name, character.userContext);

        // Write to the live record, not to whatever copy was handed in, otherwise the
        // enhanced profile is saved onto an object nothing else is looking at.
        const live = getLiveCharacter(character) || character;
        live.enhancedContext = enhancedContext;
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

        // Show success message
        recordActivity(CastLog.KINDS.CHARACTER_ENHANCED, `${character.name}, ${enhancedContext.length} characters`);
        showSuccess(`Character ${character.name} has been enhanced!`);

        // Update the container of this specific character if it exists
        const characterItem = document.getElementById(`character-item-${characterId}`);
        if (characterItem) {
            // Find or create enhanced context container
            let enhancedContainer = characterItem.querySelector('.enhanced-context');
            if (!enhancedContainer) {
                enhancedContainer = document.createElement('div');
                enhancedContainer.className = 'mt-3 bg-gray-50 p-2 rounded enhanced-context';

                // Insert before the button container
                const buttonContainer = characterItem.querySelector('.mt-3');
                if (buttonContainer) {
                    characterItem.insertBefore(enhancedContainer, buttonContainer);
                } else {
                    characterItem.appendChild(enhancedContainer);
                }
            }

            // Update the content
            enhancedContainer.innerHTML = `
                <p class="text-sm text-gray-700 font-semibold">Enhanced Context:</p>
                <div class="text-gray-600 text-sm mt-1 max-h-60 overflow-auto p-1 border rounded bg-white">
                    ${enhancedContext}
                </div>
            `;

            // Reset the enhance button
            resetEnhanceButton(enhanceButton, "Re-Enhance Context");
        } else {
            // If we can't find the individual item, update the whole list
            const characterListContainer = document.getElementById('character-list');
            if (characterListContainer) {
                characterListContainer.innerHTML = generateCharacterListHTML();
            }
            resetEnhanceButton(enhanceButton);
        }
    } catch (error) {
        console.error("Error enhancing character:", error);
        showError(`Failed to enhance character: ${error.message}`);
        resetEnhanceButton(enhanceButton);
    }
}

// Helper function to reset enhance button
function resetEnhanceButton(button, text = 'Enhance Context') {
    if (button) {
        button.innerHTML = `<i class="fas fa-magic mr-1"></i> ${text}`;
        button.disabled = false;
    }
}

async function callEnhanceAPI(characterName, userContext) {
    // Calculate approximate word count based on token limit (0.75 tokens per word)
    const wordLimit = Math.floor(appSettings.enhancedContextTokens * 0.75);

    const prompt = `
You are an expert character developer for roleplaying. Transform this brief character description into a detailed character profile that can guide an AI in consistently roleplaying as this character.
Fill in the details about but dont sound like the character, because this is for generating a character context which will be used to roleplay with the user. Importantly do not have a starting message at
all, like for example Here's a comprehensive character profile of the character, designed to guide..... Do not do that!!!  Just start providing the character profile without any confirmation.
CHARACTER NAME: "${characterName}"

BRIEF DESCRIPTION (that user provided that needs to be enhanced with more critical details):
"${userContext}"

CREATE A COMPREHENSIVE CHARACTER PROFILE INCLUDING:
1. Personality traits with specific behavioral examples
2. Distinctive speech patterns, vocabulary choices, and verbal tics
3. Background information and formative experiences that shaped them
4. Core motivations, values, and life goals
5. Key relationships and how they interact with different types of people
6. Emotional responses to various situations (angry, happy, stressed, etc.)
7. Physical appearance and mannerisms if relevant
8. Skills, knowledge areas, and expertise
9. Fears, insecurities, and internal conflicts

FORMAT AS A COHESIVE PROFILE THAT DEFINES THE CHARACTER'S ESSENCE.
- Make the character feel authentic and three-dimensional with consistent traits.
- Include specific examples of how they would speak and react.
- Write in third person.
- IMPORTANT: Your response MUST be approximately ${wordLimit} words or fewer to fit within the token limit of ${appSettings.enhancedContextTokens} tokens. Focus on depth and specificity rather than length.
`;

    try {
        // Use the regular callGeminiAPI function which already uses appSettings
        const result = await callGeminiAPI(prompt);
        return result;
    } catch (error) {
        console.error("Error enhancing character:", error);
        throw error;
    }
}
