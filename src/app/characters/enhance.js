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

    // The progress panel overlays the body of the card, so the grid never grows
    // or jumps while a long profile arrives.
    const enhanceButton = document.querySelector(`#enhance-btn-${characterId}`);
    const characterItem = document.getElementById(`character-item-${characterId}`);
    const progress = showEnhanceProgress(characterItem, character.name);
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
                if (progress) progress.remove();
                resetEnhanceButton(enhanceButton);
                return;
            }
        } catch (error) {
            showError(`API initialization failed: ${error.message}`);
            if (progress) progress.remove();
            resetEnhanceButton(enhanceButton);
            return;
        }
    }

    // Call API
    try {
        const enhancedContext = await callEnhanceAPI(
            character.name,
            character.userContext,
            (text) => updateEnhanceProgress(progress, text)
        );

        // Write to the live record, not to whatever copy was handed in, otherwise the
        // enhanced profile is saved onto an object nothing else is looking at.
        const live = getLiveCharacter(character) || character;
        live.enhancedContext = enhancedContext;
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

        // Show success message
        recordActivity(CastLog.KINDS.CHARACTER_ENHANCED, `${character.name}, ${enhancedContext.length} characters`);
        showSuccess(`Character ${character.name} has been enhanced!`);

        // Rebuild from the one canonical card template. The former ad-hoc
        // enhanced-context box permanently changed one card's height and used
        // unescaped model output as HTML.
        renderFilteredAndSortedCharacters();
    } catch (error) {
        console.error("Error enhancing character:", error);
        showError(`Failed to enhance character: ${error.message}`);
        if (progress) progress.remove();
        resetEnhanceButton(enhanceButton);
    }
}

function showEnhanceProgress(card, characterName) {
    if (!card) return null;
    const panel = document.createElement('section');
    panel.className = 'char-enhance-progress';
    panel.setAttribute('aria-live', 'polite');

    const heading = document.createElement('div');
    heading.className = 'char-enhance-progress-head';
    const spinner = document.createElement('i');
    spinner.className = 'fas fa-wand-magic-sparkles';
    const label = document.createElement('span');
    label.className = 'char-enhance-progress-label';
    label.textContent = `Building ${characterName}'s profile…`;
    heading.appendChild(spinner);
    heading.appendChild(label);

    const output = document.createElement('div');
    output.className = 'char-enhance-output';
    output.textContent = 'Connecting to the model…';
    panel.appendChild(heading);
    panel.appendChild(output);
    card.appendChild(panel);
    return panel;
}

function updateEnhanceProgress(panel, text) {
    if (!panel) return;
    const output = panel.querySelector('.char-enhance-output');
    if (!output) return;
    output.textContent = text;
    output.scrollTop = output.scrollHeight;
    const label = panel.querySelector('.char-enhance-progress-label');
    if (label) label.textContent = `Writing profile · ${text.length.toLocaleString()} characters`;
}

// Helper function to reset enhance button
function resetEnhanceButton(button) {
    if (button) {
        const characterId = button.id.replace(/^enhance-btn-/, '');
        const character = state.characters.find(entry => entry.id === characterId);
        const text = character && character.enhancedContext ? 'Rebuild profile' : 'Build profile';
        button.innerHTML = `<i class="fas fa-wand-magic-sparkles"></i> ${text}`;
        button.disabled = false;
    }
}

async function callEnhanceAPI(characterName, userContext, onUpdate) {
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
        const result = await callAITextStream(prompt, appSettings.enhancedContextTokens, onUpdate);
        return result;
    } catch (error) {
        console.error("Error enhancing character:", error);
        throw error;
    }
}
