import * as path from 'path';
import * as vscode from 'vscode';
// Steam library search shared with the VPK scripts (extract-images.js, sync-dota-data.js)
import { findDota2InSteamLibraries, steamRoots } from '../../scripts/lib/dota-install';

/** Show a file or folder in the system file manager (Explorer / Finder / ...) */
export function revealInOS(filePath: string) {
	vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
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
