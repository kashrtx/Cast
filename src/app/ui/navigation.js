// Moving between the parts of the app.
//
// changeView is the one way a view changes, and everything else here supports it: the sliding
// indicator under the tabs, keeping the fixed header's height in step with the space left for
// content, and the focus handling that stops a phone keyboard covering the message box.
//
// The maths for the sliding indicator is in src/segmentnav.js and tested there. What is left here
// is the part that needs a real page.

// Closes the current chat and returns to the home screen.
//
// There was no way back before. Opening a chat replaced the home screen and nothing ever
// brought it back, so it could only be seen again by reloading the page.
function returnToHome() {
    state.activeChat = null;
    state.activeCharacters = [];
    state.selectedCharacters = [];

    const chatWindow = document.getElementById('chat-window');
    const placeholder = document.getElementById('chat-placeholder');
    const chatView = document.getElementById('chat-view');

    if (chatWindow) chatWindow.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
    if (chatView) chatView.classList.remove('chat-active');

    renderChatHome('');
    updateSidebarCharacters();
}

// Tells the stylesheet how tall the header actually is.
//
// A lot of the layout is sized as the viewport minus the header, and that used to be
// written as a fixed 56 pixels in a dozen places. Giving the header a taller navigation
// broke every one of them: the chat, characters and settings views all ended up taller
// than the space available, and since that space does not scroll, everything below the
// fold became unreachable.
//
// Measured here and published as a variable, so the layout follows whatever the header
// actually is rather than what it was assumed to be.
function trackHeaderHeight() {
    const header = document.querySelector('header');
    if (!header) return;

    const apply = () => {
        const height = Math.round(header.getBoundingClientRect().height);
        if (height > 0) {
            document.documentElement.style.setProperty('--header-h', `${height}px`);
        }
    };

    apply();
    window.addEventListener('resize', debounce(apply, 100));

    // Fonts and icons load after first paint and can change the height.
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(apply).catch(() => {});
    }

    // Watches the header itself, so anything that changes its size is picked up without
    // having to remember to call this.
    if (typeof ResizeObserver === 'function') {
        try {
            new ResizeObserver(apply).observe(header);
        } catch (error) {
            // Not important enough to worry about if unavailable.
        }
    }
}

// The sliding navigation.
//
// Tap a section and the pill slides to it. Or take hold anywhere on the strip and drag,
// and the pill follows and settles on whichever section you let go nearest to.
//
// The arithmetic is in src/segmentnav.js and tested there. This part only measures the
// page and moves things.
function setupSlidingNav() {
    const nav = document.getElementById('main-nav');
    const pill = document.getElementById('seg-pill');
    if (!nav || !pill) return;

    const items = nav.querySelectorAll('.seg-item');
    if (!items.length) return;

    let segments = [];
    let activeIndex = 0;
    let dragging = false;
    let startPointerX = 0;
    let startLeft = 0;
    let pillWidth = 0;
    let livePillLeft = 0;

    const measure = () => {
        segments = CastSegmentNav.measureSegments(items, nav);
    };

    // Puts the pill somewhere. Called both mid drag and on settling.
    const placePill = (left, width) => {
        livePillLeft = left;
        pill.style.width = `${width}px`;
        pill.style.transform = `translateX(${left}px)`;
        paintLabels(left, width);
    };

    // Lights the labels according to where the pill is, so the one underneath it is
    // always the readable one rather than only lighting up at the end.
    const paintLabels = (left, width) => {
        segments.forEach((segment, index) => {
            const item = items[index];
            if (!item) return;
            const emphasis = CastSegmentNav.labelEmphasis(left, width, segment);
            item.classList.toggle('is-active', emphasis > 0.5);
        });
    };

    // Settles on a section, and tells the app to change view.
    const settleOn = (index, { navigate = true } = {}) => {
        measure();
        const target = CastSegmentNav.segmentGeometry(segments, index);
        activeIndex = CastSegmentNav.clamp(index, 0, segments.length - 1);
        pillWidth = target.width;
        placePill(target.left, target.width);

        items.forEach((item, i) => {
            item.setAttribute('aria-selected', i === activeIndex ? 'true' : 'false');
        });

        const view = segments[activeIndex] ? segments[activeIndex].view : '';
        if (navigate && view) changeView(view);
    };

    // Lets other parts of the app move the pill, for instance when a view is opened by
    // something other than this strip.
    window.castMoveNavTo = (view) => {
        measure();
        const index = segments.findIndex(segment => segment.view === view);
        if (index !== -1 && index !== activeIndex) settleOn(index, { navigate: false });
    };

    // --- Dragging ---

    const onPointerDown = (event) => {
        // Left button or touch only.
        if (event.button !== undefined && event.button !== 0) return;

        measure();
        const current = CastSegmentNav.segmentGeometry(segments, activeIndex);
        pillWidth = current.width;
        startLeft = current.left;
        startPointerX = event.clientX;
        dragging = true;

        nav.classList.add('is-dragging');
        if (nav.setPointerCapture && event.pointerId !== undefined) {
            try { nav.setPointerCapture(event.pointerId); } catch (error) { /* not important */ }
        }
    };

    const onPointerMove = (event) => {
        if (!dragging) return;
        event.preventDefault();

        // Bounded by the first and last sections rather than by the strip's full width,
        // because the strip has padding and the pill would otherwise slide out over it.
        const first = segments[0];
        const last = segments[segments.length - 1];
        const lowest = first ? first.left : 0;
        const highest = last ? (last.left + last.width - pillWidth) : 0;

        const followed = startLeft + (event.clientX - startPointerX);
        const left = CastSegmentNav.clamp(followed, lowest, Math.max(lowest, highest));
        placePill(left, pillWidth);
    };

    const onPointerUp = (event) => {
        if (!dragging) return;
        dragging = false;
        nav.classList.remove('is-dragging');

        // A still finger is a tap on whichever section is under it.
        //
        // Which section that is has to be worked out from where the pointer is, not from
        // the event target. Capturing the pointer retargets every later pointer event to
        // the strip itself, so the target was never the button and a tap did nothing at
        // all. Only dragging worked.
        if (CastSegmentNav.wasATap(startPointerX, event.clientX)) {
            const navBox = nav.getBoundingClientRect();
            const localX = event.clientX - navBox.left;
            const tappedIndex = segments.findIndex(segment =>
                localX >= segment.left && localX <= segment.left + segment.width
            );
            settleOn(tappedIndex === -1 ? activeIndex : tappedIndex);
            return;
        }

        settleOn(CastSegmentNav.nearestIndex(livePillLeft, pillWidth, segments));
    };

    nav.addEventListener('pointerdown', onPointerDown);
    nav.addEventListener('pointermove', onPointerMove);
    nav.addEventListener('pointerup', onPointerUp);

    // Swallow the click that follows a pointer interaction.
    //
    // The buttons carry their own click handlers from elsewhere in the app, each one
    // switching to its own section. Releasing a drag over one button while the pill has
    // settled on another meant two different sections were requested: the pill went where
    // it was dropped, then the click sent the view somewhere else, and the two disagreed.
    // The pointer handling above already decides where to go, so the click is redundant.
    //
    // Checked with detail, which is the click count for a real press and zero for a click
    // synthesised by pressing Enter or Space on a focused button. So keyboard use still
    // works normally and only pointer driven clicks are dropped.
    nav.addEventListener('click', (event) => {
        if (event.detail > 0) {
            event.stopPropagation();
            event.preventDefault();
        }
    }, true);

    nav.addEventListener('pointercancel', () => {
        if (!dragging) return;
        dragging = false;
        nav.classList.remove('is-dragging');
        settleOn(activeIndex, { navigate: false });
    });

    // --- Keyboard ---

    nav.addEventListener('keydown', (event) => {
        const next = CastSegmentNav.indexForKey(event.key, activeIndex, items.length);
        if (next !== activeIndex) {
            event.preventDefault();
            settleOn(next);
            if (items[next]) items[next].focus();
        }
    });

    // Fonts loading or the window changing size both move the sections, so remeasure.
    window.addEventListener('resize', debounce(() => settleOn(activeIndex, { navigate: false }), 120));
    if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => settleOn(activeIndex, { navigate: false })).catch(() => {});
    }

    // Place it without navigating, so setting up does not change the view.
    settleOn(0, { navigate: false });
}

// View management
function changeView(viewName) {
    // Hide all views
    const views = ['chat-view', 'characters-view', 'settings-view'];
    views.forEach(view => {
        const element = document.getElementById(view);
        if (element) {
            element.classList.add('hidden');
            if (view === 'chat-view') {
                element.classList.remove('chat-active');
            }
        }
    });

    // Reset active buttons
    const buttons = ['chat-btn', 'characters-btn', 'settings-btn'];
    // The active look is the sliding pill behind the buttons now, so nothing here paints
    // a background onto them. Doing so would cover the pill.
    buttons.forEach(btn => {
        const element = document.getElementById(btn);
        if (element) element.classList.remove('bg-white', 'text-primary', 'text-white');
    });

    // Make sure nothing has left the page locked.
    //
    // A stray inline overflow on the body is what broke scrolling repeatedly. Clearing it
    // here means that even if something sets it again, changing view puts it right.
    document.body.style.overflow = '';
    document.body.style.position = '';

    // Keep the pill in step when the view is changed by something other than the
    // navigation strip itself.
    if (typeof window.castMoveNavTo === 'function') {
        window.castMoveNavTo(viewName);
    }

    // Toggle body class for fixed positioning only in chat view
    if (viewName === 'chat') {
        document.body.classList.add('chat-view-active');
    } else {
        document.body.classList.remove('chat-view-active');
    }

    // Show selected view and activate button
    if (viewName === 'chat') {
        const view = document.getElementById('chat-view');
        const btn = document.getElementById('chat-btn');
        if (view) {
            view.classList.remove('hidden');
            updateCharacterLists(); // Refresh the list when switching views

            // Add chat-active class if there's an active chat
            if (state.activeChat) {
                view.classList.add('chat-active');
            }
        }
        // The pill marks the current section.
    } else if (viewName === 'characters') {
        const view = document.getElementById('characters-view');
        const btn = document.getElementById('characters-btn');
        if (view) view.classList.remove('hidden');
        // The pill marks the current section.
    } else if (viewName === 'settings') {
        const view = document.getElementById('settings-view');
        const btn = document.getElementById('settings-btn');
        if (view) view.classList.remove('hidden');
        // The pill marks the current section.
    }
}

// Add this near the debounce function
function setupFocusHandling() {
    // Fix for mobile viewport issues - ensures viewport-fit=cover for notches
    const metaViewport = document.querySelector('meta[name=viewport]');
    if (metaViewport) {
        // Ensure width, initial-scale, and viewport-fit are set
        let content = metaViewport.content;
        if (!content.includes("width=device-width")) {
            content += ", width=device-width";
        }
        if (!content.includes("initial-scale=1.0")) {
            content += ", initial-scale=1.0";
        }
        if (!content.includes("viewport-fit=cover")) {
            content += ", viewport-fit=cover";
        }
        // Normalize by removing leading/trailing commas and spaces
        metaViewport.content = content.replace(/^,|,$/g, '').replace(/,\s*,/g, ',').trim();
    }

    const messageInput = document.getElementById('message-input');
    const body = document.body; // Use body from here

    // Detect if we're on iOS for specific resize logic
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

    if (!messageInput) return;

    // Focus handling function - ensures input is visible when focused
    const handleFocus = () => {
        body.classList.add('keyboard-visible');

        // Set fixed position style for message container to prevent jumping (from old setupMobileViewportFix)
        const messageContainer = document.querySelector('.p-4.bg-white.border-t');
        if (messageContainer) {
            messageContainer.style.zIndex = '1000';
        }

        // Wait for keyboard to appear
        setTimeout(() => {
            // Generic scroll to the input field
            messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });

            // Scroll to bottom of chat window
            const chatMessages = document.getElementById('chat-messages');
            if (chatMessages) {
                chatMessages.scrollTop = chatMessages.scrollHeight;
            }
        }, 300);
    };

    // Blur handling function - resets when keyboard is hidden
    const handleBlur = () => {
        body.classList.remove('keyboard-visible');
    };

    // Add event listeners
    messageInput.addEventListener('focus', handleFocus);
    messageInput.addEventListener('blur', handleBlur);

    // Setup resize event listener for keyboard detection on Android (non-IOS devices)
    if (!isIOS) {
        const initialHeight = window.innerHeight;
        window.addEventListener('resize', debounce(() => {
            // If height is significantly smaller, keyboard is likely visible
            if (window.innerHeight < initialHeight * 0.75) {
                body.classList.add('keyboard-visible');

                // Adjust messages container position
                setTimeout(() => {
                    if (messageInput) { // Check if messageInput is still valid
                        messageInput.scrollIntoView({ block: 'end', behavior: 'smooth' });
                    }
                }, 100);
            } else {
                body.classList.remove('keyboard-visible');
            }
        }, 100));
    }
}
