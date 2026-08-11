// Copies the app into a folder for publishing.
//
// There is nothing to compile. This exists because Netlify does not want the functions directory
// living inside the directory being published, and publishing the repository root would also serve
// the source as static files. So the app is copied into public/ and that is what gets published.
//
// Opening index.html straight from the repository still works exactly as before. This only runs on
// deploy.

const fs = require('fs');
const path = require('path');

const OUT = 'public';

// Everything the app needs in a browser. Tests, tooling and the function are left out.
const FILES = [
    'index.html',
    'script.js',
    'style.css',
    'local-ai-bridge.user.js',
];
const FOLDERS = ['src', 'assets'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

FILES.forEach((file) => {
    if (!fs.existsSync(file)) {
        console.error(`missing ${file}`);
        process.exit(1);
    }
    fs.copyFileSync(file, path.join(OUT, file));
});

FOLDERS.forEach((folder) => {
    if (!fs.existsSync(folder)) return;
    fs.cpSync(folder, path.join(OUT, folder), { recursive: true });
});

const count = FILES.length + FOLDERS.reduce(
    (total, folder) => total + (fs.existsSync(folder) ? fs.readdirSync(folder).length : 0),
    0
);
console.log(`Copied ${count} files into ${OUT}/`);
