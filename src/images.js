// Profile pictures.
//
// The problem this solves
//
// Pictures used to be stored as base64 text inside localStorage, right alongside
// the characters and chats. Browsers give a page somewhere around five megabytes
// of localStorage in total, and base64 makes a file about a third larger than it
// started. A single two megabyte photo therefore took well over half of the
// space available for everything.
//
// Measured on a real backup from this app: four pictures were using three
// megabytes, one of them alone was 1.7 megabytes, and the whole store was at two
// thirds of the limit with only nine characters. Every saved message rewrote the
// entire chats value, so once the limit was reached those writes started failing
// and the newest messages quietly vanished on the next reload.
//
// Two changes fix it for good.
//
// First, pictures are shrunk before they are stored. A profile picture is
// displayed at well under two hundred pixels, so keeping a four thousand pixel
// original is pure waste.
//
// Second, pictures move to IndexedDB, which is measured in hundreds of megabytes
// rather than five, and which lives separately from localStorage. Text data can
// no longer be crowded out by a picture no matter how many characters there are.

(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    } else {
        root.CastImages = api;
    }
})(typeof self !== "undefined" ? self : this, function () {
    const DB_NAME = "cast-images";
    const DB_VERSION = 1;
    const STORE_NAME = "pictures";

    // A profile picture is shown at 40 to 96 pixels in the lists and a bit
    // larger on the edit screen. 512 is generous even for a high density
    // display, and it keeps files small.
    const MAX_DIMENSION = 512;
    const JPEG_QUALITY = 0.85;

    // Anything under this is already small enough to leave alone.
    const SKIP_RESIZE_BELOW_BYTES = 40 * 1024;

    function estimateDataUrlBytes(dataUrl) {
        if (typeof dataUrl !== "string") return 0;
        const comma = dataUrl.indexOf(",");
        const payload = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
        // Four base64 characters encode three bytes.
        return Math.floor((payload.length * 3) / 4);
    }

    // Works out the target size while keeping the aspect ratio.
    function fitWithin(width, height, maxDimension) {
        const limit = maxDimension || MAX_DIMENSION;
        if (!width || !height) return { width: limit, height: limit };
        if (width <= limit && height <= limit) {
            return { width, height };
        }
        const scale = Math.min(limit / width, limit / height);
        return {
            width: Math.max(1, Math.round(width * scale)),
            height: Math.max(1, Math.round(height * scale)),
        };
    }

    // Shrinks a data URL using a canvas. Browser only.
    // Transparent images are kept as PNG, everything else becomes JPEG because
    // it is far smaller for photographs.
    function shrinkDataUrl(dataUrl, options) {
        const settings = options || {};
        const maxDimension = settings.maxDimension || MAX_DIMENSION;
        const quality = settings.quality || JPEG_QUALITY;

        return new Promise((resolve, reject) => {
            if (typeof document === "undefined") {
                resolve(dataUrl);
                return;
            }

            const looksTransparent = /^data:image\/(png|gif|webp)/i.test(dataUrl);
            const alreadySmall = estimateDataUrlBytes(dataUrl) < SKIP_RESIZE_BELOW_BYTES;

            const image = new Image();

            image.onload = () => {
                try {
                    const target = fitWithin(image.naturalWidth, image.naturalHeight, maxDimension);
                    const noResizeNeeded = target.width === image.naturalWidth
                        && target.height === image.naturalHeight;

                    if (alreadySmall && noResizeNeeded) {
                        resolve(dataUrl);
                        return;
                    }

                    const canvas = document.createElement("canvas");
                    canvas.width = target.width;
                    canvas.height = target.height;

                    const context = canvas.getContext("2d");
                    if (!context) {
                        resolve(dataUrl);
                        return;
                    }

                    context.imageSmoothingEnabled = true;
                    context.imageSmoothingQuality = "high";

                    if (!looksTransparent) {
                        // JPEG has no transparency, so fill white first rather
                        // than letting it come out black.
                        context.fillStyle = "#ffffff";
                        context.fillRect(0, 0, target.width, target.height);
                    }

                    context.drawImage(image, 0, 0, target.width, target.height);

                    const type = looksTransparent ? "image/png" : "image/jpeg";
                    const shrunk = canvas.toDataURL(type, quality);

                    // If shrinking somehow made it bigger, keep the original.
                    resolve(shrunk.length < dataUrl.length ? shrunk : dataUrl);
                } catch (error) {
                    // A picture that will not shrink is not worth failing over.
                    resolve(dataUrl);
                }
            };

            image.onerror = () => reject(new Error("That image could not be read."));
            image.src = dataUrl;
        });
    }

    // Reads a File into a data URL.
    function readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target.result);
            reader.onerror = () => reject(new Error("That file could not be read."));
            reader.readAsDataURL(file);
        });
    }

    // --- IndexedDB ---

    let dbPromise = null;

    function openDatabase() {
        if (dbPromise) return dbPromise;

        dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === "undefined") {
                reject(new Error("This browser has no IndexedDB."));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("Could not open the picture store."));
        });

        return dbPromise;
    }

    function withStore(mode, work) {
        return openDatabase().then((db) => new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, mode);
            const store = transaction.objectStore(STORE_NAME);
            let result;

            try {
                result = work(store);
            } catch (error) {
                reject(error);
                return;
            }

            transaction.oncomplete = () => resolve(result && result.value !== undefined ? result.value : result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error("The picture store rejected the change."));
        }));
    }

    function putPicture(characterId, dataUrl) {
        return withStore("readwrite", (store) => {
            store.put(dataUrl, characterId);
            return { value: true };
        });
    }

    function getPicture(characterId) {
        return withStore("readonly", (store) => {
            const request = store.get(characterId);
            const holder = { value: undefined };
            request.onsuccess = () => { holder.value = request.result; };
            return holder;
        });
    }

    function deletePicture(characterId) {
        return withStore("readwrite", (store) => {
            store.delete(characterId);
            return { value: true };
        });
    }

    function getAllPictures() {
        return withStore("readonly", (store) => {
            const holder = { value: {} };
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                holder.value[cursor.key] = cursor.value;
                cursor.continue();
            };
            return holder;
        });
    }

    // Takes a picture from a file, shrinks it, and stores it.
    // Returns the stored data URL so it can be shown straight away.
    function saveFromFile(characterId, file, options) {
        return readFileAsDataUrl(file)
            .then((dataUrl) => shrinkDataUrl(dataUrl, options))
            .then((shrunk) => putPicture(characterId, shrunk).then(() => shrunk));
    }

    // Moves pictures that are still sitting inside character records into the
    // picture store, shrinking them on the way.
    //
    // This is what makes an old backup work. The file still has its pictures
    // embedded as base64, they get pulled out on load, and the character record
    // is left holding a marker instead of three megabytes of text.
    function migrateEmbeddedPictures(characters, options) {
        const list = Array.isArray(characters) ? characters : [];
        const settings = options || {};
        const shrink = settings.shrink !== false;

        const results = {
            moved: 0,
            failed: 0,
            bytesBefore: 0,
            bytesAfter: 0,
            characters: [],
        };

        const steps = list.map((character) => {
            if (!character || typeof character !== "object") {
                results.characters.push(character);
                return Promise.resolve();
            }

            const copy = Object.assign({}, character);
            const picture = copy.profilePicture;

            if (typeof picture !== "string" || picture.indexOf("data:") !== 0) {
                results.characters.push(copy);
                return Promise.resolve();
            }

            results.bytesBefore += estimateDataUrlBytes(picture);

            const prepare = shrink
                ? shrinkDataUrl(picture, settings).catch(() => picture)
                : Promise.resolve(picture);

            return prepare
                .then((finalPicture) => {
                    results.bytesAfter += estimateDataUrlBytes(finalPicture);
                    return putPicture(copy.id, finalPicture);
                })
                .then(() => {
                    // The record now points at the picture store rather than
                    // carrying the picture itself.
                    copy.hasPicture = true;
                    delete copy.profilePicture;
                    results.moved += 1;
                    results.characters.push(copy);
                })
                .catch(() => {
                    // If the move fails, leave the picture where it was. Worse
                    // for space, but nothing is lost.
                    results.failed += 1;
                    results.characters.push(copy);
                });
        });

        return Promise.all(steps).then(() => results);
    }

    // Rough size of the picture store, for the storage panel in Settings.
    function measureStore() {
        return getAllPictures().then((pictures) => {
            let bytes = 0;
            let count = 0;
            Object.keys(pictures || {}).forEach((key) => {
                bytes += estimateDataUrlBytes(pictures[key]);
                count += 1;
            });
            return { bytes, count };
        });
    }

    return {
        MAX_DIMENSION,
        JPEG_QUALITY,
        DB_NAME,
        STORE_NAME,
        estimateDataUrlBytes,
        fitWithin,
        shrinkDataUrl,
        readFileAsDataUrl,
        openDatabase,
        putPicture,
        getPicture,
        deletePicture,
        getAllPictures,
        saveFromFile,
        migrateEmbeddedPictures,
        measureStore,
    };
});
