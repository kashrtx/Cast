// Everything about the app's name and identity lives here.
// If you ever want to rename the app, this is the only file you need to touch.
// The name is read from here by the page title, the header, the settings screen,
// and the backup filenames.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastBrand = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const BRAND = {
        // The display name, shown to people.
        name: "Cast",

        // A short line that explains what the app is.
        tagline: "Your cast of characters",

        // Used as the prefix for backup filenames. Keep it filename safe,
        // so no spaces and no punctuation beyond dashes.
        fileSlug: "cast",

        // Bumped when the storage shape changes in a way the loader cares about.
        dataVersion: 2,

        // The app version, shown in Settings.
        appVersion: "2.21.1",
    };

    return BRAND;
});
