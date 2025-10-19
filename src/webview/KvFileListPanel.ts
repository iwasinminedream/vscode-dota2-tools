import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KvEditorSettings } from '../module/kvEditorConfig';
import { getWebviewContent } from '../utils/getWebViewContent';
import { readKeyValue2 } from '../utils/kvUtils';
import { localize } from '../utils/localize';

interface KvFileListItem {
	name: string;
	fullPath: string;
	relativePath: string;
	size: number;
	mtime: number;
	summary: string[];
}

interface KvFileListPayload {
	folderPath: string;
	rootPath: string;
	folderType: KvEditorSettings['folderType'];
	files: KvFileListItem[];
}

export class KvFileListPanel implements vscode.Disposable {
	private static currentPanel: KvFileListPanel | undefined;

	public static show(context: vscode.ExtensionContext, folderPath: string, settings: KvEditorSettings): void {
		if (KvFileListPanel.currentPanel) {
			KvFileListPanel.currentPanel.update(folderPath, settings);
			return;
		}
		KvFileListPanel.currentPanel = new KvFileListPanel(context, folderPath, settings);
	}

	public static disposeCurrent() {
		KvFileListPanel.currentPanel?.panel.dispose();
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];
	private currentFolder: string;
	private currentSettings: KvEditorSettings;

	private constructor(private readonly context: vscode.ExtensionContext, folderPath: string, settings: KvEditorSettings) {
		this.currentFolder = folderPath;
		this.currentSettings = settings;
		this.panel = vscode.window.createWebviewPanel(
			'dota2tools.kvFileList',
			this.getTitle(folderPath),
			{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
			{ enableScripts: true, retainContextWhenHidden: true }
		);
		this.initialize();
	}

	dispose(): void {
		KvFileListPanel.currentPanel = undefined;
		while (this.disposables.length) {
			const disposable = this.disposables.pop();
			try {
				disposable?.dispose();
			} catch (error) {
				// ignore
			}
		}
	}

	private async initialize() {
		this.panel.webview.html = await getWebviewContent(this.panel.webview, this.context.extensionUri, 'KvFileList');
		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message))
		);
	}

	private handleMessage(message: any) {
		switch (message?.type) {
			case 'ready':
				void this.pushData();
				break;
			case 'openFile':
				if (typeof message.path === 'string') {
					void vscode.commands.executeCommand('dota2tools.kvEditor.openFile', vscode.Uri.file(message.path));
				}
				break;
			case 'refresh':
				void this.pushData();
				break;
		}
	}

	private async pushData() {
		const payload: KvFileListPayload = {
			folderPath: this.currentFolder,
			rootPath: this.currentSettings.rootPath,
			folderType: this.currentSettings.folderType,
			files: await this.collectFileInfo(this.currentFolder, this.currentSettings)
		};
		this.panel.title = this.getTitle(this.currentFolder);
		this.panel.webview.postMessage({ type: 'update', payload });
	}

	private async collectFileInfo(folderPath: string, settings: KvEditorSettings): Promise<KvFileListItem[]> {
		let dirents: fs.Dirent[] = [];
		try {
			dirents = await fs.promises.readdir(folderPath, { withFileTypes: true });
		} catch (error) {
			return [];
		}
		const files = dirents.filter((item) => item.isFile() && this.isKvFile(item.name));
		const items: KvFileListItem[] = [];
		for (const file of files) {
			const fullPath = path.join(folderPath, file.name);
			try {
				const stat = await fs.promises.stat(fullPath);
				const summary = await this.createSummary(fullPath, settings.folderType);
				items.push({
					name: file.name,
					fullPath,
					relativePath: path.relative(settings.rootPath, fullPath),
					size: stat.size,
					mtime: stat.mtimeMs,
					summary
				});
			} catch (error) {
				// skip broken file
			}
		}
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	private isKvFile(filename: string): boolean {
		const lower = filename.toLowerCase();
		return lower.endsWith('.kv') || lower.endsWith('.txt');
	}

	private async createSummary(filePath: string, folderType: KvEditorSettings['folderType']): Promise<string[]> {
		try {
			const content = await fs.promises.readFile(filePath, 'utf-8');
			const kvData = readKeyValue2(content);
			const header = Object.keys(kvData)[0];
			if (!header) {
				return [];
			}
			const block = kvData[header];
			const keys = Object.keys(block);
			if (folderType === 'abilities') {
				return keys.slice(0, 3).map((key) => this.composeAbilitySummary(key, block[key]));
			}
			if (folderType === 'units') {
				return keys.slice(0, 3).map((key) => this.composeUnitSummary(key, block[key]));
			}
			return keys.slice(0, 3);
		} catch (error) {
			return [];
		}
	}

	private composeAbilitySummary(key: string, abilityData: any): string {
		const note = abilityData?.Note ?? abilityData?.AbilityTextureName ?? '';
		return note ? `${key} · ${note}` : key;
	}

	private composeUnitSummary(key: string, unitData: any): string {
		const role = unitData?.Role ?? unitData?.ArmorPhysical ?? '';
		return role ? `${key} · ${role}` : key;
	}

	private update(folderPath: string, settings: KvEditorSettings) {
		this.currentFolder = folderPath;
		this.currentSettings = settings;
		void this.pushData();
	}

	private getTitle(folderPath: string): string {
		return `${localize('pluginName')} · ${path.basename(folderPath)}`;
	}
}
