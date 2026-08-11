// Profile pictures: choosing them, shrinking them, and keeping them out of the way.
//
// Pictures live in their own store rather than alongside the text, because a few of them at full
// size will fill the text storage on their own and then nothing else can be saved. Shrinking and
// storing is in src/images.js. This file is the app's side: moving pictures out of old data,
// reading them once at start up so lists can draw without waiting, and the upload controls.
//
// A browser with no picture store, which is what a private window can be, falls through to showing
// initials rather than failing.

// Moves pictures out of the crowded text storage and into the picture store.
//
// This is what makes an old backup work without any effort from you. The file
// still has its pictures embedded, they get pulled out on load, and the character
// record is left with a marker instead of megabytes of text.
async function migratePicturesIfNeeded() {
    const needsMoving = (state.characters || []).some(
        character => character && typeof character.profilePicture === 'string'
            && character.profilePicture.indexOf('data:') === 0
    );
    if (!needsMoving) return;

    console.log("Moving profile pictures into their own store.");
    const migration = await CastImages.migrateEmbeddedPictures(state.characters);

    if (!migration.moved) return;

    state.characters = migration.characters;
    const saved = migration.bytesBefore - migration.bytesAfter;
    const wrote = setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);

    if (wrote) {
        console.log(`Moved ${migration.moved} pictures and saved ${formatBytes(saved)}.`);
        await preloadPictures();
        updateCharacterLists();
        updateSidebarCharacters();
        updateStoragePanel();
        if (saved > 100 * 1024) {
            showSuccess(`Tidied up ${migration.moved} profile pictures and freed ${formatBytes(saved)} of space.`, 5000);
        }
    }
}

// Reads the pictures once so the lists can draw without waiting on the database
// for every row.
//
// It also clears any hasPicture flag whose picture is genuinely missing. A file
// written by version 2.0.0 claimed pictures it did not contain, because the export
// did not fetch them from their store. Leaving the flag set makes the app look
// like it is still loading something that will never arrive.
async function preloadPictures() {
    try {
        state.pictureCache = await CastImages.getAllPictures();
    } catch (error) {
        console.warn("Pictures could not be read:", error);
        state.pictureCache = {};
    }

    let corrected = 0;
    (state.characters || []).forEach(character => {
        if (!character || !character.hasPicture) return;
        const hasData = Boolean(state.pictureCache[character.id])
            || (typeof character.profilePicture === 'string' && character.profilePicture);
        if (!hasData) {
            delete character.hasPicture;
            corrected += 1;
        }
    });

    if (corrected) {
        console.log(`${corrected} characters were marked as having a picture that is not here. Showing their initial instead.`);
        setStoredItem(STORAGE_KEYS.CHARACTERS, state.characters);
    }
}

// Where the rest of the app asks for a character's picture.
function getCharacterPicture(character) {
    if (!character) return '';
    // A picture still embedded in the record, from before the move.
    if (typeof character.profilePicture === 'string' && character.profilePicture) {
        return character.profilePicture;
    }
    return (state.pictureCache && state.pictureCache[character.id]) || '';
}

function setupProfilePictureHandlers() {
    // Setup for the create character form
    const profilePictureUpload = document.getElementById('profile-picture-upload');
    const profilePicturePreview = document.getElementById('profile-picture-preview');
    const removeProfilePictureBtn = document.getElementById('remove-profile-picture');

    if (profilePictureUpload && profilePicturePreview) {
        // Handle file selection
        profilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // The limit is now much higher than the old 2MB, because the
                // picture gets shrunk before it is stored. What used to matter was
                // that a 2MB photo became roughly 2.7MB of text and ate over half
                // of the browser's storage allowance for the whole app. That is no
                // longer how pictures are kept, so a big original is fine.
                const maxSize = 12 * 1024 * 1024;
                if (file.size > maxSize) {
                    showError("That image is very large. Please pick one under 12MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = async function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("That image is too small. It needs to be at least 50 by 50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported. Please use a still image.");
                            return;
                        }

                        // Shrink it before it goes anywhere. A profile picture is
                        // shown at well under 200 pixels, so keeping a 4000 pixel
                        // original was pure waste.
                        let prepared = event.target.result;
                        try {
                            prepared = await CastImages.shrinkDataUrl(event.target.result);
                            const before = CastImages.estimateDataUrlBytes(event.target.result);
                            const after = CastImages.estimateDataUrlBytes(prepared);
                            if (before > after) {
                                console.log(`Picture shrunk from ${formatBytes(before)} to ${formatBytes(after)}.`);
                            }
                        } catch (error) {
                            console.warn("That picture could not be shrunk, using it as it is:", error);
                        }

                        // Held here until the character is saved, at which point it
                        // moves into the picture store.
                        state.pendingProfilePicture = prepared;

                        profilePicturePreview.innerHTML = '';
                        const preview = document.createElement('img');
                        preview.src = prepared;
                        preview.alt = 'Profile preview';
                        preview.className = 'w-full h-full object-cover';
                        profilePicturePreview.appendChild(preview);
                        profilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (removeProfilePictureBtn) {
                            removeProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (removeProfilePictureBtn) {
            removeProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                profilePictureUpload.value = '';

                // Forget the picture being held, otherwise removing it here and
                // then saving would still attach it.
                state.pendingProfilePicture = null;

                // Reset the preview
                profilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                profilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                removeProfilePictureBtn.classList.add('hidden');
            });
        }
    }

    // Setup for the edit character modal
    const editProfilePictureUpload = document.getElementById('edit-profile-picture-upload');
    const editProfilePicturePreview = document.getElementById('edit-profile-picture-preview');
    const editRemoveProfilePictureBtn = document.getElementById('edit-remove-profile-picture');

    if (editProfilePictureUpload && editProfilePicturePreview) {
        // Handle file selection
        editProfilePictureUpload.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                // Validate file type
                const validTypes = ['image/jpeg', 'image/png', 'image/webp'];

                // Additional check for GIF files (in case the browser ignores the accept attribute)
                const isGif = file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
                if (isGif) {
                    showError("GIF files are not supported to prevent performance issues. Please use JPG, PNG or WebP instead.");
                    return;
                }

                if (!validTypes.includes(file.type)) {
                    showError("Please select a valid image file (JPG, PNG or WebP only)");
                    return;
                }

                // Same reasoning as the create screen. The picture is shrunk
                // before it is stored, so a large original is not a problem.
                const maxSize = 12 * 1024 * 1024;
                if (file.size > maxSize) {
                    showError("That image is very large. Please pick one under 12MB.");
                    return;
                }

                // Read the file and create a preview
                const reader = new FileReader();
                reader.onload = (event) => {
                    // Create an image element to get dimensions
                    const img = new Image();
                    img.onload = async function () {
                        // Check if dimensions are reasonable
                        if (img.width < 50 || img.height < 50) {
                            showError("That image is too small. It needs to be at least 50 by 50 pixels.");
                            return;
                        }

                        // Check for animated PNG (APNG)
                        if (event.target.result.indexOf('ANIM') !== -1 || event.target.result.indexOf('acTL') !== -1) {
                            showError("Animated images are not supported. Please use a still image.");
                            return;
                        }

                        let prepared = event.target.result;
                        try {
                            prepared = await CastImages.shrinkDataUrl(event.target.result);
                        } catch (error) {
                            console.warn("That picture could not be shrunk, using it as it is:", error);
                        }

                        state.pendingEditProfilePicture = prepared;

                        editProfilePicturePreview.innerHTML = '';
                        const preview = document.createElement('img');
                        preview.src = prepared;
                        preview.alt = 'Profile preview';
                        preview.className = 'w-full h-full object-cover';
                        editProfilePicturePreview.appendChild(preview);
                        editProfilePicturePreview.classList.add('has-image');

                        // Show the remove button
                        if (editRemoveProfilePictureBtn) {
                            editRemoveProfilePictureBtn.classList.remove('hidden');
                        }
                    };
                    img.src = event.target.result;
                };
                reader.readAsDataURL(file);
            }
        });

        // Handle remove button click
        if (editRemoveProfilePictureBtn) {
            editRemoveProfilePictureBtn.addEventListener('click', () => {
                // Reset the file input
                editProfilePictureUpload.value = '';

                // Forget the picture being held, so removing it here and saving
                // actually removes it.
                state.pendingEditProfilePicture = null;

                // Reset the preview
                editProfilePicturePreview.innerHTML = '<i class="fas fa-user"></i>';
                editProfilePicturePreview.classList.remove('has-image');

                // Hide the remove button
                editRemoveProfilePictureBtn.classList.add('hidden');
            });
        }
    }
}
