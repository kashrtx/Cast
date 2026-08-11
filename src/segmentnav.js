// The sliding navigation.
//
// Three sections with a pill behind the active one. Tap a section and the pill slides
// there. Or take hold of the pill and drag it, and it follows you and settles on
// whichever section you let go nearest to.
//
// The awkward parts of this are all arithmetic, so they live here where they can be
// tested, and the file that touches the page only has to move things around.
//
// Two details that make the difference between this feeling right and feeling cheap:
//
// While you are dragging there is no animation at all. The pill sits exactly under your
// finger. Any easing during a drag reads as lag.
//
// When you let go, it eases with a curve that overshoots very slightly, which is what
// makes it feel like a physical object settling rather than a box being repositioned.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastSegmentNav = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    // How far you have to move before it counts as a drag rather than a tap. Below this
    // it is treated as a tap, so a slightly unsteady finger still selects a section.
    const DRAG_THRESHOLD = 6;

    function clamp(value, low, high) {
        if (high < low) return low;
        return Math.min(high, Math.max(low, value));
    }

    // Where the pill sits for a given section.
    function segmentGeometry(segments, index) {
        const list = Array.isArray(segments) ? segments : [];
        if (!list.length) return { left: 0, width: 0 };

        const chosen = list[clamp(index, 0, list.length - 1)];
        if (!chosen) return { left: 0, width: 0 };

        return { left: chosen.left, width: chosen.width };
    }

    // Which section is nearest to a pill sitting at this position?
    //
    // Compared centre to centre rather than by which edges overlap, because comparing
    // edges makes a wide section swallow a narrow neighbour and the pill then refuses to
    // settle on the narrow one.
    function nearestIndex(pillLeft, pillWidth, segments) {
        const list = Array.isArray(segments) ? segments : [];
        if (!list.length) return 0;

        const pillCentre = pillLeft + pillWidth / 2;

        let best = 0;
        let bestDistance = Infinity;

        list.forEach((segment, index) => {
            const centre = segment.left + segment.width / 2;
            const distance = Math.abs(centre - pillCentre);
            if (distance < bestDistance) {
                bestDistance = distance;
                best = index;
            }
        });

        return best;
    }

    // Where the pill should be mid drag.
    //
    // It follows the pointer but cannot leave the track. The width stays that of the
    // section it started from, so it does not resize under your finger, which looks
    // like a glitch.
    function dragPosition({ startPointerX, currentPointerX, startLeft, pillWidth, trackWidth }) {
        const movement = currentPointerX - startPointerX;
        const maximum = Math.max(0, trackWidth - pillWidth);
        return clamp(startLeft + movement, 0, maximum);
    }

    // How far through the track the pill is, from 0 to 1. Used to fade the labels as it
    // passes over them, which is the part that sells it as one continuous movement.
    function trackProgress(pillLeft, pillWidth, trackWidth) {
        const maximum = Math.max(1, trackWidth - pillWidth);
        return clamp(pillLeft / maximum, 0, 1);
    }

    // How strongly a label should look active, from 0 to 1, given where the pill is.
    //
    // A label lights up as the pill arrives over it rather than snapping on at the end,
    // so during a drag the text under the pill is always the readable one.
    function labelEmphasis(pillLeft, pillWidth, segment) {
        if (!segment || !segment.width) return 0;

        const pillCentre = pillLeft + pillWidth / 2;
        const segmentCentre = segment.left + segment.width / 2;
        const distance = Math.abs(pillCentre - segmentCentre);

        // Fully lit when the centres line up, off by the time the pill is a whole
        // section away.
        const falloff = Math.max(1, segment.width);
        return clamp(1 - distance / falloff, 0, 1);
    }

    // Did that count as a tap or a drag?
    function wasATap(startPointerX, endPointerX) {
        return Math.abs(endPointerX - startPointerX) < DRAG_THRESHOLD;
    }

    // Keyboard movement, so this is not mouse only.
    function indexForKey(key, currentIndex, count) {
        if (!count) return 0;
        switch (key) {
            case "ArrowLeft": return clamp(currentIndex - 1, 0, count - 1);
            case "ArrowRight": return clamp(currentIndex + 1, 0, count - 1);
            case "Home": return 0;
            case "End": return count - 1;
            default: return currentIndex;
        }
    }

    // Measures the sections from real elements. Returns plain numbers so everything
    // above stays testable.
    function measureSegments(elements, trackElement) {
        if (!elements || !elements.length || !trackElement) return [];

        const trackBox = trackElement.getBoundingClientRect();

        return Array.prototype.map.call(elements, (element) => {
            const box = element.getBoundingClientRect();
            return {
                left: box.left - trackBox.left,
                width: box.width,
                view: element.getAttribute("data-view") || "",
            };
        });
    }

    return {
        DRAG_THRESHOLD,
        clamp,
        segmentGeometry,
        nearestIndex,
        dragPosition,
        trackProgress,
        labelEmphasis,
        wasATap,
        indexForKey,
        measureSegments,
    };
});
