import * as fs from 'fs';
import watch from 'node-watch';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	hasExistingEntry,
	KvEditorEntry,
	KvEditorSettings,
	readKvEditorSettings,
} from '../module/kvEditorConfig';
import { localize } from '../utils/localize';

type KvTreeItemType = 'folder' | 'file' | 'placeholder';

export class KvTreeItem extends vscode.TreeItem {
	constructor(
		public readonly itemType: KvTreeItemType,
		public readonly fsPath: string | undefined,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState,
		command?: vscode.Command
	) {
		super(label, collapsibleState);
		if (fsPath) {
			this.resourceUri = vscode.Uri.file(fsPath);
		}
		if (itemType === 'folder') {
			this.iconPath = vscode.ThemeIcon.Folder;
			this.contextValue = 'kv.folder';
		} else if (itemType === 'file') {
			this.iconPath = vscode.ThemeIcon.File;
			this.contextValue = 'kv.file';
		}
		if (command) {
			this.command = command;
		}
	}
}

export class KvEditorTreeProvider implements vscode.TreeDataProvider<KvTreeItem>, vscode.Disposable {
	private watchers: ReturnType<typeof watch>[] = [];
	private _settings: KvEditorSettings | undefined;
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<KvTreeItem | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	constructor(private readonly context: vscode.ExtensionContext, settings?: KvEditorSettings) {
		this._settings = settings ?? readKvEditorSettings();
		this.registerWatcher();
	}

	dispose(): void {
		this.disposeWatcher();
		this._onDidChangeTreeData.dispose();
	}

	public get settings(): KvEditorSettings | undefined {
		return this._settings;
	}

	public updateSettings(settings?: KvEditorSettings) {
		this._settings = settings ?? readKvEditorSettings();
		this.registerWatcher();
		this.refresh();
	}

	public refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	getTreeItem(element: KvTreeItem): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: KvTreeItem): Promise<KvTreeItem[]> {
		if (!this._settings) {
			return [this.createPlaceholderItem(localize('kvEditor.configureFolder'))];
		}
		if (!hasExistingEntry(this._settings)) {
			return [this.createPlaceholderItem(localize('kvEditor.folderMissing'))];
		}

		if (!element) {
			return this.buildRootItems(this._settings);
		}

		if (element.itemType !== 'folder' || !element.fsPath) {
			return [];
		}
		return this.readDirectory(element.fsPath);
	}

	private async readDirectory(dir: string): Promise<KvTreeItem[]> {
		let entries: fs.Dirent[] = [];
		try {
			entries = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch (error) {
			return [];
		}
		const folders: KvTreeItem[] = [];
		const files: KvTreeItem[] = [];
		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				folders.push(new KvTreeItem('folder', entryPath, entry.name, vscode.TreeItemCollapsibleState.Collapsed));
			} else if (this.isKvFile(entry.name)) {
				files.push(new KvTreeItem('file', entryPath, entry.name, vscode.TreeItemCollapsibleState.None, {
					command: 'dota2tools.kvEditor.openFile',
					title: 'Open KV',
					arguments: [vscode.Uri.file(entryPath)]
				}));
			}
		}
		folders.sort((a, b) => this.getLabelText(a).localeCompare(this.getLabelText(b)));
		files.sort((a, b) => this.getLabelText(a).localeCompare(this.getLabelText(b)));
		return [...folders, ...files];
	}

	private getLabelText(item: KvTreeItem): string {
		if (typeof item.label === 'string') {
			return item.label;
		}
		if (item.label && typeof item.label === 'object') {
			return item.label.label ?? '';
		}
		return '';
	}

	private isKvFile(filename: string): boolean {
		const lower = filename.toLowerCase();
		return lower.endsWith('.kv') || lower.endsWith('.txt');
	}

	private createPlaceholderItem(label: string): KvTreeItem {
		return new KvTreeItem('placeholder', undefined, label, vscode.TreeItemCollapsibleState.None, {
			command: 'workbench.action.openSettings',
			title: 'open settings',
			arguments: ['dota2-tools.A10.kv_editor']
		});
	}

	private buildRootItems(settings: KvEditorSettings): KvTreeItem[] {
		const folders: KvTreeItem[] = [];
		const files: KvTreeItem[] = [];
		for (const entry of settings.entries) {
			if (!entry.exists) {
				continue;
			}
			const item = this.createEntryItem(entry);
			if (entry.isDirectory) {
				folders.push(item);
			} else {
				files.push(item);
			}
		}
		if (folders.length === 0 && files.length === 0) {
			return [this.createPlaceholderItem(localize('kvEditor.folderMissing'))];
		}
		folders.sort((a, b) => this.getLabelText(a).localeCompare(this.getLabelText(b)));
		files.sort((a, b) => this.getLabelText(a).localeCompare(this.getLabelText(b)));
		return [...folders, ...files];
	}

	private createEntryItem(entry: KvEditorEntry): KvTreeItem {
		const label = path.basename(entry.resolvedPath) || entry.resolvedPath;
		const collapsible = entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
		const command = entry.isDirectory
			? undefined
			: {
				command: 'dota2tools.kvEditor.openFile',
				title: 'Open KV',
				arguments: [vscode.Uri.file(entry.resolvedPath)],
			};
		const item = new KvTreeItem(entry.isDirectory ? 'folder' : 'file', entry.resolvedPath, label, collapsible, command);
		const tooltipParts = [entry.resolvedPath];
		if (entry.rawPath !== entry.resolvedPath) {
			tooltipParts.push(`配置: ${entry.rawPath}`);
		}
		item.tooltip = tooltipParts.join('\n');
		item.description = entry.type;
		return item;
	}

	private registerWatcher() {
		this.disposeWatcher();
		if (!this._settings) {
			return;
		}
		const watchers: ReturnType<typeof watch>[] = [];
		const seen = new Set<string>();
		for (const entry of this._settings.entries) {
			if (!entry.exists || !entry.isDirectory) {
				continue;
			}
			const key = entry.resolvedPath.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			try {
				watchers.push(watch(entry.resolvedPath, { recursive: true }, () => this.refresh()));
			} catch (error) {
				// ignore watcher failures
			}
		}
		this.watchers = watchers;
	}

	private disposeWatcher() {
		for (const watcher of this.watchers) {
			try {
				watcher.close();
			} catch (error) {
				// ignore
			}
		}
		this.watchers = [];
	}
}