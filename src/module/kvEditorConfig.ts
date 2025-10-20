import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getContentDir, getGameDir } from './addonInfo';

export type KvFolderType = 'ability' | 'item' | 'unit' | 'custom';

export interface KvEditorSettings {
	entries: KvEditorEntry[];
}

export interface KvEditorEntry {
	rawPath: string;
	resolvedPath: string;
	type: KvFolderType;
	exists: boolean;
	isDirectory: boolean;
}

const CONFIG_KEY = 'dota2-tools.A10.kv_editor.paths';
const SUPPORTED_TYPES = new Set<KvFolderType>(['ability', 'item', 'unit', 'custom']);

export function readKvEditorSettings(): KvEditorSettings | undefined {
	const config = vscode.workspace.getConfiguration().get<Record<string, string>>(CONFIG_KEY);
	if (!config || typeof config !== 'object') {
		return undefined;
	}
	const entries: KvEditorEntry[] = [];
	for (const [rawPath, rawType] of Object.entries(config)) {
		if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
			continue;
		}
		const resolvedPath = resolveConfiguredPath(rawPath.trim());
		if (!resolvedPath) {
			continue;
		}
		const type = toFolderType(rawType);
		const { exists, isDirectory } = probePath(resolvedPath);
		entries.push({
			rawPath,
			resolvedPath,
			type,
			exists,
			isDirectory,
		});
	}
	if (!entries.length) {
		return undefined;
	}
	return { entries };
}

export function hasExistingEntry(settings: KvEditorSettings | undefined): boolean {
	return Boolean(settings?.entries.some((entry) => entry.exists));
}

export function findKvEntryForUri(uri: vscode.Uri, settings?: KvEditorSettings): KvEditorEntry | undefined {
	const activeSettings = settings ?? readKvEditorSettings();
	if (!activeSettings) {
		return undefined;
	}
	const normalizedTarget = normalizeForComparison(uri.fsPath);
	for (const entry of activeSettings.entries) {
		if (!entry.exists) {
			continue;
		}
		const normalizedSource = normalizeForComparison(entry.resolvedPath);
		if (entry.isDirectory) {
			if (isSameOrParent(normalizedSource, normalizedTarget)) {
				return entry;
			}
		} else if (normalizedSource === normalizedTarget) {
			return entry;
		}
	}
	return undefined;
}

function toFolderType(rawType: unknown): KvFolderType {
	if (typeof rawType === 'string') {
		const lower = rawType.toLowerCase();
		if (SUPPORTED_TYPES.has(lower as KvFolderType)) {
			return lower as KvFolderType;
		}
	}
	return 'custom';
}

function resolveConfiguredPath(rawPath: string): string | undefined {
	const replacements = new Map<string, string | undefined>([
		['game', getGameDir()],
		['content', getContentDir()],
		['workspace', getWorkspaceRoot()],
	]);
	let candidate = rawPath;
	candidate = candidate.replace(/\\/g, '/');
	candidate = candidate.replace(/\$\{(game|content|workspace)\}/gi, (match, key: string) => {
		const replacement = replacements.get(key.toLowerCase());
		return replacement ?? '';
	});
	if (!candidate || !candidate.trim()) {
		return undefined;
	}
	const normalizedCandidate = candidate.trim();
	if (path.isAbsolute(normalizedCandidate)) {
		return normalizePath(normalizedCandidate);
	}
	const workspace = getWorkspaceRoot();
	if (workspace) {
		return normalizePath(path.join(workspace, normalizedCandidate));
	}
	return normalizePath(path.resolve(normalizedCandidate));
}

function probePath(target: string): { exists: boolean; isDirectory: boolean; } {
	try {
		const stat = fs.statSync(target);
		return { exists: true, isDirectory: stat.isDirectory() };
	} catch (error) {
		return { exists: false, isDirectory: false };
	}
}

function normalizePath(input: string): string {
	return path.normalize(input);
}

function normalizeForComparison(input: string): string {
	const normalized = path.normalize(input);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrParent(parent: string, child: string): boolean {
	if (parent === child) {
		return true;
	}
	const withSep = parent.endsWith(path.sep) ? parent : parent + path.sep;
	return child.startsWith(withSep);
}

function getWorkspaceRoot(): string | undefined {
	const folder = vscode.workspace.workspaceFolders?.[0];
	return folder?.uri.fsPath;
}
