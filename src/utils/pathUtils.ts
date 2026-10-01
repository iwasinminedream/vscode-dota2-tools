import * as fs from 'fs';
import * as path from 'path';
/**
 * Read path info
 * @param {string} path The path
 */
export function getPathInfo(path: string): Promise<boolean | fs.Stats> {
	return new Promise((resolve, reject) => {
		fs.stat(path, (err, stats) => {
			if (err) {
				resolve(false);
			} else {
				resolve(stats);
			}
		});
	});
}

/**
 * Create a directory
 * @param {string} dir The path
 */
export async function makeDir(dir: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		fs.mkdir(dir, err => {
			if (err) {
				resolve(false);
			} else {
				resolve(true);
			}
		});
	});
}

/**
 * Whether the path exists; create it if it does not
 * @param {string} dir The path
 */
export async function dirExists(dir: string) {
	let isExists = await getPathInfo(dir);
	//If the path exists and is not a file, return true
	if (isExists && isExists !== true && isExists.isDirectory()) {
		return true;
	} else if (isExists) {	 //If the path exists but is a file, return false
		return false;
	}
	//If the path does not exist
	let tempDir = path.parse(dir).dir;	  //Get the parent path
	//Recursively check; if the parent directory also does not exist, the code keeps looping here until the directory exists
	let status = await dirExists(tempDir);
	let mkdirStatus;
	if (status) {
		mkdirStatus = await makeDir(dir);
	}
	return mkdirStatus;
}

/**
 * A file inside an addon folder, with native separators on every platform
 * @param root addon game/content directory
 * @param relative '/'-separated path inside it, e.g. "scripts/npc/items_game.kv"
 */
export function addonFilePath(root: string, relative: string): string {
	return path.join(root, ...relative.split('/').filter(Boolean));
}

/**
 * Language folder of a changed localization file: <localizationDir>/<language>/.../x.txt → <language>.
 * Files lying directly in <localizationDir> have no language (undefined).
 */
export function localizationLanguageOf(localizationDir: string, filePath: string): string | undefined {
	const relative = path.relative(localizationDir, path.dirname(filePath));
	if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
		return undefined;
	}
	return relative.split(/[\\/]/)[0];
}

/** "<root>/game/dota_rogue" → "<root>/design/tools/Decompiler-windows/maps/chapter", keeping the path's separator */
export function chapterMapsDir(gameDir: string): string {
	return gameDir.replace(/game([\\/])dota_rogue/, "design$1tools$1Decompiler-windows$1maps$1chapter");
}