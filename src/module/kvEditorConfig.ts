import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getPathConfiguration } from '../utils/getPathConfiguration';

export type KvFolderType = 'abilities' | 'units' | 'custom';

export interface KvEditorSettings {
	rootPath: string;
	folderType: KvFolderType;
}

function resolveRootPath(rawPath: string): string {
	if (path.isAbsolute(rawPath)) {
		return path.normalize(rawPath);
	}
	const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
	if (workspaceFolder) {
		return path.normalize(path.join(workspaceFolder.uri.fsPath, rawPath));
	}
	return path.normalize(path.resolve(rawPath));
}

export function readKvEditorSettings(): KvEditorSettings | undefined {
	const rootPathSetting = getPathConfiguration('dota2-tools.A10.kv_editor.rootPath');
	if (!rootPathSetting) {
		return undefined;
	}
	const rootPath = resolveRootPath(rootPathSetting);
	const typeSetting = vscode.workspace.getConfiguration().get<string>('dota2-tools.A10.kv_editor.type', 'custom');
	const folderType: KvFolderType = (typeSetting === 'abilities' || typeSetting === 'units' || typeSetting === 'custom') ? typeSetting : 'custom';
	return { rootPath, folderType };
}

export function ensureRootExists(settings: KvEditorSettings | undefined): boolean {
	if (!settings) {
		return false;
	}
	try {
		return fs.existsSync(settings.rootPath);
	} catch (error) {
		return false;
	}
}

export function isPathInsideRoot(targetPath: string, settings: KvEditorSettings | undefined): boolean {
	if (!settings) {
		return false;
	}
	const normalizedTarget = path.normalize(targetPath);
	const normalizedRoot = path.normalize(settings.rootPath);
	return normalizedTarget.startsWith(normalizedRoot);
}

export function getKvFolderTypeForUri(uri: vscode.Uri, settings?: KvEditorSettings): KvFolderType {
	const activeSettings = settings ?? readKvEditorSettings();
	if (isPathInsideRoot(uri.fsPath, activeSettings)) {
		return activeSettings!.folderType;
	}
	return 'custom';
}
