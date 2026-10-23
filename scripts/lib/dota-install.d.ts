/* Types for dota-install.js (shared by the extension and the VPK scripts) */

/** Folders Steam installs to on this platform */
export function steamRoots(): string[];

/** The Steam root and the libraries its steamapps/libraryfolders.vdf lists */
export function steamLibraries(root: string): string[];

/** "dota 2 beta" in the platform's Steam root or one of its libraries, or undefined */
export function findDota2InSteamLibraries(): string | undefined;

/** The main VPK of a Dota 2 install */
export function dotaVpk(dotaDir: string): string;

/** Dota 2 install with its VPKs: `explicit`, DOTA2_DIR, the Steam libraries, (Windows) D:/E:/F: libraries */
export function findDota2(explicit?: string): string | undefined;
