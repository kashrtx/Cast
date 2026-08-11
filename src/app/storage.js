// Reading and writing storage, and what to do when it will not fit.
//
// The actual saving is in src/storage.js, which knows nothing about this app and is tested on its
// own. This file is the layer between the two: it holds the one store the app uses, wraps get and
// set so every caller reports a failure the same way, and turns a failed write into something a
// person can act on rather than a silent loss.
//
// Storage filling up is the failure that matters here, because pictures and long chats are large
// and the browser gives no warning. Anything that cannot be written is recorded rather than
// swallowed.

// Helper functions

// IDs now come from the ids module. The old version sliced a random number into
// a string, which occasionally produced an ID only one or two characters long,
// and never checked whether an ID was already in use.
const generateUniqueId = () => {
    const taken = new Set();
    (state.characters || []).forEach(c => { if (c && c.id) taken.add(c.id); });
    Object.keys(state.chats || {}).forEach(chatId => {
        taken.add(chatId);
        const body = state.chats[chatId];
        if (Array.isArray(body)) body.forEach(m => { if (m && m.id) taken.add(m.id); });
    });
    return CastIds.generateUniqueId(taken);
};

// The single store every read and write goes through.
const castStore = CastStorage.createStore();

// Kept with the same names and shapes as before so the rest of the app did not
// need rewriting. The behaviour underneath is different in two ways that matter.
// Reading never throws, and writing tells the truth about whether it worked.
const getStoredItem = (key, defaultValue = null) => {
    const result = castStore.read(key, CastStorage.SHAPES[key]);
    if (result.missing && defaultValue !== null && defaultValue !== undefined) {
        return defaultValue;
    }
    if (result.problem) {
        recordStorageProblem(result.problem);
    }
    return result.value;
};

// Every failed write is now surfaced instead of being swallowed. Running out of
// room used to mean messages silently disappeared on the next reload, which was
// the single biggest cause of chat history feeling unreliable.
const setStoredItem = (key, value) => {
    const result = castStore.write(key, value);
    if (!result.ok) {
        reportSaveFailure(key, result);
        return false;
    }
    noteDataChanged();
    return true;
};

// Problems found while loading, shown to the reader once start up has finished
// rather than thrown away into the console.
let storageProblems = [];

function recordStorageProblem(problem) {
    if (!problem) return;
    storageProblems.push(problem);
    console.warn(`Storage problem on ${problem.key}: ${problem.detail}`);
    recordActivityIfReady(CastLog.KINDS.DATA_SET_ASIDE, `${problem.key}: ${problem.detail}`);
}

function reportSaveFailure(key, result) {
    recordActivityIfReady(CastLog.KINDS.SAVE_FAILED, `${key} could not be written: ${result.reason}`);

    if (result.reason === "quota") {
        showError("There is no room left in this browser's storage, so that change was not saved. Open Settings and use Storage to see what is taking up space, then save a backup before clearing anything.");
        return;
    }
    if (result.reason === "verify-failed") {
        showError("This browser accepted the change but did not keep it, which usually means storage is full. Save a backup now to be safe.");
        return;
    }
    console.error(`Could not save ${key}: ${result.reason}`);
    showError("That change could not be saved. Your existing data is untouched.");
}
