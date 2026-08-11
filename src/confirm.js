// Asking before doing something that cannot be undone.
//
// Why this exists
//
// Deleting a character had no confirmation at all. The delete button sat right
// next to the edit button in the character list, and one stray tap removed the
// character and every chat with them. Deleting a message was the same. On a
// phone, where the buttons are small and close together, that is far too easy to
// do by accident.
//
// The browser's own confirm() would have worked, but it looks out of place in an
// app styled after Messages, and on a phone it is a jarring system popup. This is
// the same idea in the app's own styling, and it follows the convention of
// putting the destructive choice in red and letting Escape cancel.
//
// It returns a promise, so a caller reads as:
//
//   if (!(await CastConfirm.ask({ ... }))) return;

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastConfirm = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const OVERLAY_ID = "cast-confirm-overlay";

    // Decides the button colour and icon from how serious the action is.
    const STYLES = {
        danger: {
            button: "bg-red-500 hover:bg-red-600",
            icon: "fa-triangle-exclamation",
            iconColour: "text-red-500",
            iconBackground: "bg-red-50",
        },
        warning: {
            button: "bg-amber-500 hover:bg-amber-600",
            icon: "fa-circle-exclamation",
            iconColour: "text-amber-500",
            iconBackground: "bg-amber-50",
        },
        normal: {
            button: "bg-primary hover:bg-primary/90",
            icon: "fa-circle-question",
            iconColour: "text-primary",
            iconBackground: "bg-indigo-50",
        },
    };

    function escapeText(value) {
        if (value === null || value === undefined) return "";
        return String(value).replace(/[&<>"']/g, (character) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
        })[character]);
    }

    function removeExisting() {
        const existing = document.getElementById(OVERLAY_ID);
        if (existing && existing.parentNode) {
            existing.parentNode.removeChild(existing);
        }
    }

    // The main entry point.
    //
    // title      what is about to happen, short
    // message    the consequence, in plain words
    // detail     optional extra line, for example how many chats will go
    // confirmText  the label on the button that does the thing
    // tone       danger, warning or normal
    function ask(options) {
        const settings = options || {};
        const tone = STYLES[settings.tone] || STYLES.danger;
        const confirmText = settings.confirmText || "Delete";
        const cancelText = settings.cancelText || "Cancel";

        return new Promise((resolve) => {
            // If the page is not ready for some reason, fall back to the
            // browser's own dialog rather than silently going ahead.
            if (typeof document === "undefined" || !document.body) {
                resolve(typeof confirm === "function" ? confirm(settings.message || "Are you sure?") : false);
                return;
            }

            removeExisting();

            const overlay = document.createElement("div");
            overlay.id = OVERLAY_ID;
            overlay.className = "fixed inset-0 bg-black bg-opacity-50 flex items-end sm:items-center justify-center z-[60] p-0 sm:p-4";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");

            // Sits at the bottom on a phone, the way an iOS sheet does, and
            // centred on a wider screen.
            overlay.innerHTML = `
                <div class="bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden">
                    <div class="p-5 text-center">
                        <div class="mx-auto mb-3 w-12 h-12 rounded-full ${tone.iconBackground} flex items-center justify-center">
                            <i class="fas ${tone.icon} ${tone.iconColour} text-xl"></i>
                        </div>
                        <h3 class="text-lg font-semibold text-gray-900 mb-1">${escapeText(settings.title || "Are you sure?")}</h3>
                        <p class="text-sm text-gray-600">${escapeText(settings.message || "")}</p>
                        ${settings.detail ? `<p class="text-xs text-gray-500 mt-2">${escapeText(settings.detail)}</p>` : ""}
                    </div>
                    <div class="flex flex-col-reverse sm:flex-row gap-2 p-4 pt-0">
                        <button type="button" data-cast-confirm="no"
                            class="flex-1 px-4 py-2.5 rounded-xl bg-gray-100 text-gray-700 font-medium hover:bg-gray-200 transition">
                            ${escapeText(cancelText)}
                        </button>
                        <button type="button" data-cast-confirm="yes"
                            class="flex-1 px-4 py-2.5 rounded-xl ${tone.button} text-white font-medium transition">
                            ${escapeText(confirmText)}
                        </button>
                    </div>
                </div>
            `;

            document.body.appendChild(overlay);

            const yesButton = overlay.querySelector('[data-cast-confirm="yes"]');
            const noButton = overlay.querySelector('[data-cast-confirm="no"]');

            let settled = false;
            const finish = (answer) => {
                if (settled) return;
                settled = true;
                document.removeEventListener("keydown", onKeyDown, true);
                removeExisting();
                resolve(answer);
            };

            function onKeyDown(event) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    finish(false);
                    return;
                }
                // Enter confirms only when the confirm button has focus, so it
                // cannot be triggered by leaning on the keyboard.
                if (event.key === "Enter" && document.activeElement === yesButton) {
                    event.preventDefault();
                    finish(true);
                }
            }

            yesButton.addEventListener("click", () => finish(true));
            noButton.addEventListener("click", () => finish(false));

            // Tapping the dark area outside cancels, which is what people expect.
            overlay.addEventListener("click", (event) => {
                if (event.target === overlay) finish(false);
            });

            document.addEventListener("keydown", onKeyDown, true);

            // Cancel takes focus, not the destructive button, so a stray tap or
            // key press does the safe thing.
            noButton.focus();
        });
    }

    return { ask, STYLES };
});
