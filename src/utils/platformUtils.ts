import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

/** Show a file or folder in the system file manager (Explorer / Finder / ...) */
export function revealInOS(filePath: string) {
	vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
}

/** Steam root folders for the current platform (Windows uses the configured path only) */
function steamRoots(): string[] {
	const home = os.homedir();
	switch (process.platform) {
		case 'darwin':
			return [path.join(home, 'Library', 'Application Support', 'Steam')];
		case 'linux':
			return [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam')];
		default:
			return [];
	}
}

/** Find "dota 2 beta" in the Steam root and every library listed in steamapps/libraryfolders.vdf */
function findDota2InSteamLibraries(): string | undefined {
	for (const root of steamRoots()) {
		const libraries = [root];
		try {
			const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
			const pathRegex = /"path"\s+"([^"]+)"/g;
			let m: RegExpExecArray | null;
			while ((m = pathRegex.exec(vdf)) !== null) {
				libraries.push(m[1].replace(/\\\\/g, '\\'));
			}
		} catch {
			// no libraryfolders.vdf - only the Steam root itself
		}
		for (const library of libraries) {
			const dota = path.join(library, 'steamapps', 'common', 'dota 2 beta');
			if (fs.existsSync(dota)) {
				return dota;
			}
		}
	}
	return undefined;
}

/**
 * Dota 2 install path from the `dota2-tools.dota2_install_path` setting.
 * On macOS/Linux a Windows path (the default, or one synced from a Windows machine via
 * Settings Sync) is ignored and the Steam libraries are searched instead.
 */
export function getDota2InstallPath(): string | undefined {
	const configured = vscode.workspace.getConfiguration().get<string>('dota2-tools.dota2_install_path');
	if (process.platform === 'win32') {
		return configured;
	}
	if (configured && !/^[a-zA-Z]:[\\/]/.test(configured)) {
		return configured;
	}
	const found = findDota2InSteamLibraries();
	if (found !== undefined) {
		return found;
	}
	const roots = steamRoots();
	return roots.length > 0 ? path.join(roots[0], 'steamapps', 'common', 'dota 2 beta') : configured;
}
