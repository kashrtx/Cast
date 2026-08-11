// Small helpers for turning values into something readable.
//
// Dates as people write them, byte counts as sizes, and the debounce used to stop a search box
// running a filter on every keystroke. Nothing here touches the page or the app's data, which is
// why it is a file of its own: these are the easiest things in the app to reuse and to test.

// Formatting a timestamp for reading.
//
// There was a formatter already, but it was declared inside another function, so it was
// not reachable from anywhere else. Calling it from the home screen threw a reference
// error, which stopped the home screen drawing at all and reported a start up failure.
function formatDateTime(timestamp) {
    const date = new Date(timestamp);
    if (!timestamp || Number.isNaN(date.getTime())) return "";

    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();

    const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (sameDay) return time;

    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

    return `${date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${time}`;
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} bytes`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

// Utility function to debounce frequent events like resize
function debounce(func, wait) {
    let timeout;
    return function () {
        const context = this;
        const args = arguments;
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            func.apply(context, args);
        }, wait);
    };
}
