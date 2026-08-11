// Putting notifications on the screen.
//
// The queue, the timings and the shortening of long messages are in src/toast.js, which has no idea
// there is a page. This file is the other half: it draws what that decides, and it is where the
// rest of the app calls in with showError, showSuccess and notify.
//
// It also installs the catch-all error reporting, so a fault anywhere in the app becomes a notice
// and a log entry instead of a silent stop with a message only the console ever sees.

// Nothing may fail silently.
//
// A reply stopped arriving with no message of any kind, which is the worst way for
// something to break: there is nothing to act on and nothing to report. These two
// handlers catch anything that escapes the normal paths, including a failure inside a
// finally block or a promise nobody awaited, both of which otherwise only ever reach the
// console.
function installFailsafeErrorReporting() {
    window.addEventListener('error', (event) => {
        const message = event && event.message ? event.message : 'Something went wrong.';
        console.error('Uncaught error:', event);
        recordActivityIfReady(CastLog.KINDS.UNCAUGHT_ERROR, `${message} at ${event && event.filename ? event.filename.split('/').pop() : 'unknown'}:${(event && event.lineno) || '?'}`);
        showError(`Something broke: ${message}. Your data is safe. Reloading usually clears it.`);
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event && event.reason;
        const message = reason && reason.message ? reason.message : String(reason || 'unknown');
        console.error('Unhandled rejection:', reason);
        recordActivityIfReady(CastLog.KINDS.UNCAUGHT_ERROR, message);
        showError(`Something broke: ${message}. Your data is safe. Reloading usually clears it.`);
    });
}

// Notifications.
//
// Everything goes through one place, so a raw error cannot reach the screen no matter which
// call site passes one. Several of them hand over a provider's error object directly, and
// rather than trusting each to remember to tidy it up first, it is handled here.
let toastQueue = [];
const toastTimers = {};

function notify(message, kind, options) {
    const notice = CastToast.prepare({
        message,
        kind,
        title: options && options.title,
    });

    toastQueue = CastToast.enqueue(toastQueue, notice);
    renderToasts();

    // Takes itself away. Nothing sits on screen waiting to be dismissed.
    if (toastTimers[notice.id]) clearTimeout(toastTimers[notice.id]);
    toastTimers[notice.id] = setTimeout(() => dismissToast(notice.id), notice.duration);

    return notice;
}

function dismissToast(id) {
    const element = document.querySelector(`[data-toast-id="${id}"]`);

    if (toastTimers[id]) {
        clearTimeout(toastTimers[id]);
        delete toastTimers[id];
    }

    // Let it animate out before it is taken away.
    if (element) {
        element.classList.add('toast-leaving');
        setTimeout(() => {
            toastQueue = CastToast.dismiss(toastQueue, id);
            renderToasts();
        }, 220);
        return;
    }

    toastQueue = CastToast.dismiss(toastQueue, id);
    renderToasts();
}

function renderToasts() {
    let container = document.getElementById('toast-stack');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-stack';
        document.body.appendChild(container);
    }

    container.innerHTML = toastQueue.map(notice => {
        const icon = CastToast.iconFor(notice.kind);
        const repeated = notice.repeated > 1
            ? `<span class="toast-count">${notice.repeated}</span>`
            : '';
        const more = notice.hasMore
            ? `<span class="toast-more">Full detail is in the log in Settings</span>`
            : '';
        const title = notice.title
            ? `<p class="toast-title">${CastEscape.escapeHtml(notice.title)}${repeated}</p>`
            : '';

        return `
            <div class="toast toast-${CastEscape.escapeAttribute(notice.kind)}" data-toast-id="${CastEscape.escapeAttribute(notice.id)}" role="status">
                <i class="fas ${icon} toast-icon"></i>
                <div class="toast-body">
                    ${title}
                    <p class="toast-message">${CastEscape.escapeHtml(notice.message)}</p>
                    ${more}
                </div>
                <button type="button" class="toast-close" aria-label="Dismiss">
                    <i class="fas fa-xmark"></i>
                </button>
            </div>`;
    }).join('');

    // Tapping anywhere on one dismisses it, which is what people try first.
    container.querySelectorAll('[data-toast-id]').forEach(element => {
        element.addEventListener('click', () => dismissToast(element.getAttribute('data-toast-id')));
    });
}

// The old names, kept so every existing call site keeps working.
function showError(rawMessage) {
    console.warn('Notice:', rawMessage);
    notify(rawMessage, 'error');
}

function showSuccessToast(message) {
    notify(message, 'success');
}

function dismissError() {
    Object.keys(toastTimers).forEach(id => dismissToast(id));
}

// The old banner and its helpers are gone. Notices are small cards that take themselves
// away, so there is nothing left to fill or to hide.
function showErrorText(message) {
    notify(message, 'error');
}

// Success message function
function showSuccess(message, duration = 3000) {
    // Goes through the same place as everything else, so it looks the same and takes
    // itself away like everything else.
    notify(message, 'success');
}
