// The two buttons that answer "why is this not working".
//
// One sends a real request to the model that is configured and reports what came back. The other
// checks the proxy on its own, so a provider that refuses browser requests can be told apart from a
// proxy that is not there.
//
// Between them they turn "it does not work" into a sentence naming the part that failed, which is
// the difference between a report anyone can act on and one nobody can.

// Asks the proxy whether it is there.
//
// Worth having as its own button, because a chat failing tells you almost nothing about which link
// in the chain broke. This asks the proxy directly and reports exactly what came back.
async function testProxy() {
    const status = document.getElementById('proxy-status');
    const button = document.getElementById('test-proxy-btn');
    const proxyUrl = getProxyUrl();

    const say = (text, tone) => {
        if (!status) return;
        status.textContent = text;
        status.className = `text-xs mt-1 ${tone}`;
    };

    if (!proxyUrl) {
        say('There is no proxy address. Opening the file directly means there is no server to run one, so deploy the app or set an address above.', 'text-amber-600');
        return;
    }

    if (button) { button.disabled = true; button.textContent = 'Testing...'; }
    say(`Asking ${proxyUrl}...`, 'text-gray-500');

    try {
        // No target on purpose. A working proxy replies with a complaint about that, which is proof
        // it is running.
        const response = await fetch(proxyUrl, { method: 'POST' });
        const body = await response.text();

        let parsed = null;
        try { parsed = JSON.parse(body); } catch (error) { parsed = null; }

        if (parsed && parsed.error && parsed.error.source === 'cast-proxy') {
            say(`Working. The proxy answered from ${proxyUrl}, so providers that need it should work.`, 'text-green-600');
            return;
        }

        if (/^\s*<(!doctype|html)/i.test(body) || response.status === 404) {
            say(`Not deployed. ${proxyUrl} returned ${response.status} and a web page rather than the function. Check that netlify/functions is committed and that the deploy log mentions bundling ai-proxy.`, 'text-red-600');
            return;
        }

        say(`Something answered at ${proxyUrl} with ${response.status}, but it was not the proxy. First part of the reply: ${body.slice(0, 120)}`, 'text-amber-600');
    } catch (error) {
        say(`Could not reach ${proxyUrl} at all. ${error.message}`, 'text-red-600');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Test the proxy'; }
    }
}

// Test model configuration
async function testModelConfiguration() {
    const testResult = document.getElementById('test-result');
    const testStatus = document.getElementById('test-status');
    const testDetails = document.getElementById('test-details');
    const testBtn = document.getElementById('test-model-btn');
    const testIcon = document.getElementById('test-icon');

    if (!testResult || !testStatus || !testDetails || !testBtn) return;

    // The icon has three states. It used to be left spinning even after the check
    // finished, which read as though it were still going.
    const setIcon = (classes) => {
        if (testIcon) testIcon.className = classes;
    };

    testResult.classList.remove('hidden', 'bg-green-100', 'bg-red-100');
    testResult.classList.add('bg-blue-100');
    setIcon('fas fa-spinner fa-spin mt-1 text-blue-600');
    testStatus.textContent = 'Checking...';
    testDetails.textContent = `Connecting to ${getProviderDisplayName()}.`;
    testBtn.disabled = true;

    try {
        saveVisibleProviderSettings({ reinitialize: false });

        if (!isProviderConfigured()) {
            throw new Error(getProviderConfigurationMessage());
        }

        const connected = await initializeAIProvider();
        if (!connected) {
            throw new Error(`Could not connect to ${getProviderDisplayName()}.`);
        }

        testDetails.textContent = 'Connected. Asking for a short reply.';
        const response = await callAIText("Reply with exactly: working", 256);

        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-green-100');
        setIcon('fas fa-circle-check mt-1 text-green-600');
        testStatus.textContent = 'Working';
        testDetails.innerHTML = `
            <div class="space-y-1">
                <p>Provider: ${CastEscape.escapeHtml(getProviderDisplayName())}</p>
                <p>Model: ${CastEscape.escapeHtml(getModelFor())}</p>
                <p>Creativity: ${CastEscape.escapeHtml(String(appSettings.temperature))}</p>
                <p>Response limit: ${CastEscape.escapeHtml(String(getConversationTokenLimit()))} tokens</p>
                <p>It said: ${CastEscape.escapeHtml(response.substring(0, 120))}</p>
            </div>
        `;
    } catch (error) {
        testResult.classList.remove('bg-blue-100');
        testResult.classList.add('bg-red-100');
        setIcon('fas fa-circle-xmark mt-1 text-red-600');
        testStatus.textContent = 'Not working yet';
        testDetails.textContent = error.message;
        console.error('Provider test failed:', error);
    } finally {
        testBtn.disabled = false;
    }
}
