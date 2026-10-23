/**
 * dota-install.js
 *
 * Finds the Dota 2 install ("dota 2 beta") through Steam: the Steam root of the platform and every
 * library listed in its steamapps/libraryfolders.vdf. Used by the extension (src/utils/platformUtils.ts)
 * and by the VPK scripts (extract-images.js, sync-dota-data.js) on Windows, macOS and Linux.
 * process.platform and os.homedir() are read on every call (the unit tests swap them).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DOTA_FOLDER = 'dota 2 beta';

/** Folders Steam installs to on this platform */
function steamRoots() {
    const home = os.homedir();
    switch (process.platform) {
        case 'darwin':
            return [path.join(home, 'Library', 'Application Support', 'Steam')];
        case 'linux':
            return [
                path.join(home, '.steam', 'steam'),
                path.join(home, '.local', 'share', 'Steam'),
                // Steam from Flathub
                path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
            ];
        case 'win32':
            return ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam'];
        default:
            return [];
    }
}

/** The Steam root and the libraries its steamapps/libraryfolders.vdf lists */
function steamLibraries(root) {
    const libraries = [root];
    try {
        const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
        const pathRegex = /"path"\s+"([^"]+)"/g;
        let m;
        while ((m = pathRegex.exec(vdf)) !== null) {
            // vdf strings escape backslashes (Windows paths)
            libraries.push(m[1].replace(/\\\\/g, '\\'));
        }
    } catch {
        // no libraryfolders.vdf - only the Steam root itself
    }
    return libraries;
}

/** "dota 2 beta" in the platform's Steam root or one of its libraries, or undefined */
function findDota2InSteamLibraries() {
    for (const root of steamRoots()) {
        for (const library of steamLibraries(root)) {
            const dota = path.join(library, 'steamapps', 'common', DOTA_FOLDER);
            if (fs.existsSync(dota)) {
                return dota;
            }
        }
    }
    return undefined;
}

/** The main VPK of a Dota 2 install */
function dotaVpk(dotaDir) {
    return path.join(dotaDir, 'game', 'dota', 'pak01_dir.vpk');
}

/**
 * Dota 2 install with its VPKs for the scripts: `explicit` (a command-line argument), else the
 * DOTA2_DIR environment variable, else the Steam libraries, else (Windows) the usual library
 * folders on other drives. Undefined when none has game/dota/pak01_dir.vpk.
 */
function findDota2(explicit) {
    const candidates = [explicit, process.env.DOTA2_DIR, findDota2InSteamLibraries()];
    if (process.platform === 'win32') {
        for (const drive of ['D', 'E', 'F']) {
            candidates.push(`${drive}:\\SteamLibrary\\steamapps\\common\\${DOTA_FOLDER}`);
        }
    }
    return candidates.find((dir) => dir && fs.existsSync(dotaVpk(dir)));
}

module.exports = { steamRoots, steamLibraries, findDota2InSteamLibraries, dotaVpk, findDota2 };
