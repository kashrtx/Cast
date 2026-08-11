// Tests for the sliding navigation.
//
// Uneven widths are used throughout on purpose. "Chat", "Characters" and "Settings" are
// different lengths, and the awkward cases are all about a wide section next to a narrow
// one.

const test = require("node:test");
const assert = require("node:assert");
const N = require("../src/segmentnav.js");

// Roughly the real proportions: Chat is narrow, Characters is wide.
const SEGMENTS = [
    { left: 0, width: 80, view: "chat" },
    { left: 80, width: 130, view: "characters" },
    { left: 210, width: 100, view: "settings" },
];
const TRACK = 310;

test("the pill sits exactly over the section it belongs to", () => {
    assert.deepStrictEqual(N.segmentGeometry(SEGMENTS, 0), { left: 0, width: 80 });
    assert.deepStrictEqual(N.segmentGeometry(SEGMENTS, 1), { left: 80, width: 130 });
    assert.deepStrictEqual(N.segmentGeometry(SEGMENTS, 2), { left: 210, width: 100 });
});

test("an index out of range is brought back in rather than breaking", () => {
    assert.deepStrictEqual(N.segmentGeometry(SEGMENTS, -5), { left: 0, width: 80 });
    assert.deepStrictEqual(N.segmentGeometry(SEGMENTS, 99), { left: 210, width: 100 });
});

test("no sections gives a harmless zero", () => {
    assert.deepStrictEqual(N.segmentGeometry([], 0), { left: 0, width: 0 });
});

// --- Settling on the nearest section ---

test("letting go over a section settles on it", () => {
    assert.strictEqual(N.nearestIndex(0, 80, SEGMENTS), 0);
    assert.strictEqual(N.nearestIndex(80, 80, SEGMENTS), 1);
    assert.strictEqual(N.nearestIndex(215, 80, SEGMENTS), 2);
});

test("a narrow section is not swallowed by a wide neighbour", () => {
    // This is why centres are compared rather than overlapping edges. Comparing edges
    // lets the wide middle section win everywhere and the pill will not settle on Chat.
    const justOverChat = N.nearestIndex(10, 80, SEGMENTS);
    assert.strictEqual(justOverChat, 0, "sitting over Chat should choose Chat");
});

test("halfway between two sections resolves without wobbling", () => {
    // The exact midpoint must give one answer, consistently, or the pill flickers.
    const a = N.nearestIndex(40, 80, SEGMENTS);
    const b = N.nearestIndex(40, 80, SEGMENTS);
    assert.strictEqual(a, b);
});

test("dragging to the far end settles on the last section", () => {
    const atEnd = N.dragPosition({
        startPointerX: 0, currentPointerX: 9999,
        startLeft: 0, pillWidth: 100, trackWidth: TRACK,
    });
    assert.strictEqual(N.nearestIndex(atEnd, 100, SEGMENTS), 2);
});

// --- Dragging ---

test("the pill follows the pointer one to one", () => {
    const at = N.dragPosition({
        startPointerX: 100, currentPointerX: 160,
        startLeft: 0, pillWidth: 80, trackWidth: TRACK,
    });
    assert.strictEqual(at, 60, "moving 60 across should move the pill 60");
});

test("the pill cannot be dragged off the left end", () => {
    const at = N.dragPosition({
        startPointerX: 100, currentPointerX: -500,
        startLeft: 0, pillWidth: 80, trackWidth: TRACK,
    });
    assert.strictEqual(at, 0);
});

test("the pill cannot be dragged off the right end", () => {
    const at = N.dragPosition({
        startPointerX: 0, currentPointerX: 5000,
        startLeft: 210, pillWidth: 100, trackWidth: TRACK,
    });
    assert.strictEqual(at, TRACK - 100, "it should stop flush with the right edge");
});

test("a pill as wide as the track cannot move at all", () => {
    const at = N.dragPosition({
        startPointerX: 0, currentPointerX: 200,
        startLeft: 0, pillWidth: TRACK, trackWidth: TRACK,
    });
    assert.strictEqual(at, 0);
});

// --- Telling a tap from a drag ---

test("a still finger counts as a tap", () => {
    assert.strictEqual(N.wasATap(100, 100), true);
    assert.strictEqual(N.wasATap(100, 103), true, "a small wobble is still a tap");
});

test("a real movement counts as a drag", () => {
    assert.strictEqual(N.wasATap(100, 140), false);
    assert.strictEqual(N.wasATap(100, 60), false);
});

// --- Labels lighting up as the pill passes ---

test("the label under the pill is the lit one", () => {
    const overChat = N.labelEmphasis(0, 80, SEGMENTS[0]);
    const overCharacters = N.labelEmphasis(0, 80, SEGMENTS[1]);
    assert.ok(overChat > 0.9, "Chat should be lit when the pill is on it");
    assert.ok(overCharacters < 0.5, "Characters should not be");
});

test("emphasis moves across gradually rather than snapping", () => {
    // Halfway between two sections, both should be partly lit. That gradual handover is
    // what makes a drag read as one continuous movement.
    const midway = 40;
    const first = N.labelEmphasis(midway, 80, SEGMENTS[0]);
    const second = N.labelEmphasis(midway, 80, SEGMENTS[1]);
    assert.ok(first > 0 && first < 1);
    assert.ok(second > 0 && second < 1);
});

test("emphasis always stays within range", () => {
    for (let x = -50; x <= TRACK + 50; x += 7) {
        SEGMENTS.forEach((segment) => {
            const value = N.labelEmphasis(x, 80, segment);
            assert.ok(value >= 0 && value <= 1, `out of range at ${x}: ${value}`);
        });
    }
});

test("a missing section gives no emphasis rather than throwing", () => {
    assert.strictEqual(N.labelEmphasis(0, 80, null), 0);
    assert.strictEqual(N.labelEmphasis(0, 80, { left: 0, width: 0 }), 0);
});

// --- Progress along the track ---

test("progress runs from nothing to everything", () => {
    assert.strictEqual(N.trackProgress(0, 100, TRACK), 0);
    assert.strictEqual(N.trackProgress(TRACK - 100, 100, TRACK), 1);
});

test("progress stays in range even with odd numbers", () => {
    assert.strictEqual(N.trackProgress(-100, 100, TRACK), 0);
    assert.strictEqual(N.trackProgress(9999, 100, TRACK), 1);
    assert.ok(Number.isFinite(N.trackProgress(0, 100, 0)));
});

// --- Keyboard ---

test("the arrows move one section at a time", () => {
    assert.strictEqual(N.indexForKey("ArrowRight", 0, 3), 1);
    assert.strictEqual(N.indexForKey("ArrowLeft", 1, 3), 0);
});

test("the arrows stop at the ends rather than wrapping", () => {
    assert.strictEqual(N.indexForKey("ArrowLeft", 0, 3), 0);
    assert.strictEqual(N.indexForKey("ArrowRight", 2, 3), 2);
});

test("home and end jump to the ends", () => {
    assert.strictEqual(N.indexForKey("Home", 2, 3), 0);
    assert.strictEqual(N.indexForKey("End", 0, 3), 2);
});

test("any other key changes nothing", () => {
    assert.strictEqual(N.indexForKey("a", 1, 3), 1);
    assert.strictEqual(N.indexForKey("Enter", 1, 3), 1);
});

// --- Odds and ends ---

test("clamping behaves even when the range is backwards", () => {
    assert.strictEqual(N.clamp(5, 10, 0), 10);
});

test("measuring with nothing to measure gives an empty list", () => {
    assert.deepStrictEqual(N.measureSegments(null, null), []);
    assert.deepStrictEqual(N.measureSegments([], {}), []);
});

test("every section can be reached by dragging from every other", () => {
    // The real guarantee. From any starting section, dragging far enough in either
    // direction must be able to settle on any other section.
    for (let from = 0; from < SEGMENTS.length; from += 1) {
        const start = N.segmentGeometry(SEGMENTS, from);
        const reached = new Set();

        for (let move = -400; move <= 400; move += 5) {
            const at = N.dragPosition({
                startPointerX: 0, currentPointerX: move,
                startLeft: start.left, pillWidth: start.width, trackWidth: TRACK,
            });
            reached.add(N.nearestIndex(at, start.width, SEGMENTS));
        }

        assert.strictEqual(reached.size, SEGMENTS.length,
            `from section ${from} only ${reached.size} of ${SEGMENTS.length} were reachable`);
    }
});
