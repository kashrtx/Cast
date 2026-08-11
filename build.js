// Copies the app into a folder for publishing.
//
// There is nothing to compile. This exists because Netlify does not want the functions directory
// living inside the directory being published, and publishing the repository root would also serve
// the source as static files. So the app is copied into public/ and that is what gets published.
//
// Opening index.html straight from the repository still works exactly as before. This only runs on
// deploy.
//
// The list of scripts is read out of index.html rather than written down here. It used to be a
// second copy of the list, which is fine until the day the two disagree and the deployed app is
// missing a file that works perfectly well locally. Now there is one list, in the page, and a
// missing file stops the build.

const fs = require('fs');
const path = require('path');

const OUT = 'public';

// Files the app needs that are not scripts.
const EXTRA_FILES = [
    'index.html',
    'style.css',
    'local-ai-bridge.user.js',
];
const FOLDERS = ['assets'];

// Every local script the page loads. Ones fetched from a CDN are left to the CDN.
function scriptsFromPage(pageFile) {
    const html = fs.readFileSync(pageFile, 'utf8');
    const found = [];
    const pattern = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match = pattern.exec(html);
    while (match) {
        if (!/^https?:|^\/\//i.test(match[1])) found.push(match[1]);
        match = pattern.exec(html);
    }
    return found;
}

const scripts = scriptsFromPage('index.html');
const files = EXTRA_FILES.concat(scripts);

const missing = files.filter((file) => !fs.existsSync(file));
if (missing.length) {
    missing.forEach((file) => console.error(`missing ${file}`));
    process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

files.forEach((file) => {
    const destination = path.join(OUT, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
});

FOLDERS.forEach((folder) => {
    if (!fs.existsSync(folder)) return;
    fs.cpSync(folder, path.join(OUT, folder), { recursive: true });
});

console.log(`Copied ${files.length} files and ${FOLDERS.length} folder(s) into ${OUT}/`);
