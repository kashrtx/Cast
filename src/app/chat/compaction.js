// Keeping a long chat inside the token budget without losing the plot.
//
// Past a certain length a conversation no longer fits in what can be sent, and the usual answer,
// dropping the oldest messages, is what makes a character forget your name. Instead the older part
// is summarised and the summary is sent along with the recent messages.
//
// Nothing is edited or deleted. The full conversation stays exactly as it is and the summary is
// kept separately, so this can be turned off and everything is as it was. The deciding is in
// src/memory.js; this is the app's side of it.

//
// Each chat can have a summary of its older part. It is kept separately from the
// messages, which are never touched, so turning the setting off restores the full
// conversation immediately.

function getChatMemory(chatId) {
    if (!state.chatMemory || typeof state.chatMemory !== 'object') state.chatMemory = {};
    return state.chatMemory[chatId] || {};
}

function setChatMemory(chatId, memory) {
    if (!state.chatMemory) state.chatMemory = {};
    state.chatMemory[chatId] = memory;
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory);
}

function clearChatMemory(chatId) {
    if (!state.chatMemory) return;
    delete state.chatMemory[chatId];
    setStoredItem(CastStorage.KEYS.CHAT_MEMORY, state.chatMemory);
}

// Summarises the older part of a chat, if it is worth doing.
//
// Runs after a reply has been delivered, never before, so it can never delay a
// message or interfere with one. If anything fails, the chat carries on sending its
// full history. Failing here costs more tokens and nothing else.
async function maybeCompactChat(chatId, character) {
    if (!appSettings.memoryCompaction) return;
    if (!chatId || !character) return;
    if (state.isCompacting) return; // one at a time

    const messages = state.chats[chatId];
    if (!Array.isArray(messages)) return;

    const memory = getChatMemory(chatId);
    const decision = CastMemory.shouldCompact({
        messages,
        memory,
        settings: appSettings.memory,
        enabled: true,
    });

    if (!decision.compact) return;

    const plan = CastMemory.planCompaction({ messages, memory, settings: appSettings.memory });
    if (!plan.toSummarise.length) return;

    state.isCompacting = true;
    showCompactionNotice(true);

    try {
        const prompt = CastMemory.buildSummaryPrompt({
            characterName: character.name,
            userName: state.personalContext.name,
            previousSummary: plan.previousSummary,
            messages: plan.toSummarise,
        });

        // Given its own generous limit, because a cramped summary is a bad summary
        // and this only happens occasionally.
        const summary = await callAIText(prompt, 2048);

        const check = CastMemory.isUsableSummary(summary, { foldedMessages: plan.toSummarise });
        if (!check.ok) {
            console.warn(`The summary was not usable (${check.reason}), so the full conversation will keep being sent.`);
            setChatMemory(chatId, CastMemory.recordFailure(memory, check.reason));
            return;
        }

        setChatMemory(chatId, CastMemory.recordSuccess(memory, {
            summary: summary.trim(),
            coveredCount: plan.newCoveredCount,
            messageCount: plan.toSummarise.length,
        }));

        recordActivity(CastLog.KINDS.SUMMARY_MADE, `${plan.toSummarise.length} messages folded in, was roughly ${decision.tokens} tokens a turn`);
        console.log(`Summarised ${plan.toSummarise.length} older messages in this chat. Roughly ${decision.tokens} tokens a turn before.`);
        updateMemoryPanel();
    } catch (error) {
        console.warn("Summarising did not work this time:", error.message);
        setChatMemory(chatId, CastMemory.recordFailure(memory, error.message));
    } finally {
        state.isCompacting = false;
        showCompactionNotice(false);
    }
}

// A small, quiet indicator. Compaction should be visible but not alarming.
function showCompactionNotice(active) {
    const notice = document.getElementById('compaction-notice');
    if (!notice) return;
    notice.classList.toggle('hidden', !active);
}

// Says plainly what state the current chat's memory is in, so this never feels
// like something happening behind the reader's back.
function updateMemoryPanel() {
    const panel = document.getElementById('memory-panel');
    if (!panel) return;

    if (!appSettings.memoryCompaction) {
        panel.textContent = "Currently off. Every message sends the whole conversation.";
        return;
    }

    if (!state.activeChat || !Array.isArray(state.chats[state.activeChat])) {
        panel.textContent = "On. Open a chat to see what it is doing there.";
        return;
    }

    const described = CastMemory.describeMemoryState(
        getChatMemory(state.activeChat),
        state.chats[state.activeChat]
    );

    const memory = getChatMemory(state.activeChat);
    let extra = "";
    if (memory.consecutiveFailures >= 3) {
        extra = " Summarising failed a few times here, so it has stopped trying and is sending everything instead.";
    } else if (!described.compacted) {
        extra = " This chat is not long enough to be worth summarising yet.";
    }

    panel.textContent = `${described.text}${extra}`;
}
