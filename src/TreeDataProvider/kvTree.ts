import * as fs from 'fs';
import watch from 'node-watch';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureRootExists, KvEditorSettings, readKvEditorSettings } from '../module/kvEditorConfig';
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
	private watcher: ReturnType<typeof watch> | undefined;
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
		if (!ensureRootExists(this._settings)) {
			return [this.createPlaceholderItem(localize('kvEditor.folderMissing'))];
		}

		const targetDir = element?.fsPath ?? this._settings.rootPath;
		if (!targetDir) {
			return [];
		}
		return this.readDirectory(targetDir);
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

	private registerWatcher() {
		this.disposeWatcher();
		if (!this._settings || !ensureRootExists(this._settings)) {
			return;
		}
		try {
			this.watcher = watch(this._settings.rootPath, { recursive: true }, () => this.refresh());
		} catch (error) {
			// ignore watcher failures
		}
	}

	private disposeWatcher() {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = undefined;
		}
	}
}