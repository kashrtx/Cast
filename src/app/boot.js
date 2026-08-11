// Starting the app.
//
// This is the only file that runs anything by itself. Everything else defines functions and waits.
// It has to be last in the load order for that reason.
//
// Start up is a list of named steps, each in its own try, so that one failing does not stop the
// rest. An app that opens with one panel missing is worth far more than a blank page, and the step
// that failed is named in the log.

// Initialize app
document.addEventListener('DOMContentLoaded', async () => {
    console.log("DOM fully loaded - initializing app");

    // Each start up step runs inside its own guard. This is the change that
    // stops the app coming up blank. Previously these ran one after another with
    // nothing catching a failure, so an error in the first step meant the views,
    // the character list and every button were never set up, and the page looked
    // like all the data had been deleted when it was actually still there.
    // Installed first, so anything that fails during start up is also reported.
    try { installFailsafeErrorReporting(); } catch (error) { console.error(error); }

    const bootFailures = [];
    const bootStep = (name, work) => {
        try {
            work();
            return true;
        } catch (error) {
            console.error(`Start up step "${name}" failed:`, error);
            recordActivityIfReady(CastLog.KINDS.STARTUP_FAILED, `${name}: ${error.message}`);
            bootFailures.push({ name, error });
            return false;
        }
    };

    bootStep('load saved data', loadStoredData);
    bootStep('read backup reminder state', loadBackupState);

    // Pictures are read before the first render, otherwise every avatar would
    // flash blank and then fill in. Failure here is not fatal, since the lists
    // fall back to the character's initial.
    try {
        await preloadPictures();
    } catch (error) {
        console.warn("Pictures could not be read on start up:", error);
    }

    bootStep('measure the header', trackHeaderHeight);
    bootStep('show the chat view', () => changeView('chat'));
    bootStep('clear stuck typing indicators', clearStuckTypingIndicators);
    bootStep('list characters', updateCharacterLists);
    bootStep('connect buttons', setupEventListeners);
    bootStep('connect direct buttons', setupDirectListeners);
    bootStep('check the provider', checkApiKey);
    bootStep('set up the sidebar', initializeSidebar);
    bootStep('restore the sidebar state', setupSidebarCollapse);
    bootStep('set up the navigation', setupSlidingNav);
    bootStep('set up search', setupSearchBoxes);
    bootStep('set up the edit panel', setupEditModalExtras);
    bootStep('apply the chat layout', setupChatLayoutChoice);
    bootStep('apply the theme', setupThemeChoice);
    bootStep('draw the home screen', () => renderChatHome(''));
    bootStep('set up settings', initializeModelSettings);
    bootStep('show last backup time', updateLastBackupStatus);
    bootStep('start the reminder timer', startBackupReminderTimer);

    // Move any pictures still stored with the characters into the picture store.
    // Runs after the interface is up, so it never delays the app appearing.
    migratePicturesIfNeeded().catch(error => {
        console.warn("Pictures could not be moved this time:", error);
    });

    // Tell the reader about anything odd found while loading, now that there is
    // an interface to tell them in. Nothing was deleted, so the tone is
    // informational rather than alarming.
    if (storageProblems.length) {
        const keys = storageProblems.map(problem => problem.key).join(', ');
        showError(
            `Some saved data could not be read (${keys}) so it was set aside rather than deleted, and everything else loaded normally. Your other characters and chats are unaffected.`
        );
    }

    if (bootFailures.length) {
        console.error(`${bootFailures.length} start up steps failed.`, bootFailures);
        showError(
            `Part of the app did not start correctly (${bootFailures.map(f => f.name).join(', ')}). Your data is safe. Reloading the page usually clears it.`
        );
    }

    // Connect to the provider last, since it involves the network and should
    // never hold up the interface.
    if (isProviderConfigured()) {
        try {
            const connected = await initializeAIProvider({ showErrors: false });
            if (connected) {
                console.log(`${getProviderDisplayName()} connected.`);
            }
        } catch (error) {
            console.error("Could not connect to the provider on start up:", error);
        }
    }
});
