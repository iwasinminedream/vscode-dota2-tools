import axios from 'axios';
import * as vscode from 'vscode';
import { localize } from '../utils/localize';

type LogCategoryKey = 'server' | 'client' | 'ui';

interface LogConfig {
	server?: string;
	client?: string;
	ui?: string;
}

interface LogCommandPayload {
	category: LogCategoryKey;
	label: string;
}

const CATEGORY_META: Record<LogCategoryKey, { labelKey: string; iconId: string; }> = {
	server: { labelKey: 'errorLog.category.server', iconId: 'server-process' },
	client: { labelKey: 'errorLog.category.client', iconId: 'device-desktop' },
	ui: { labelKey: 'errorLog.category.ui', iconId: 'layout' }
};

export class ErrorLogTreeProvider implements vscode.TreeDataProvider<LogNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<LogNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.disposables.push(
			vscode.commands.registerCommand('dota2tools.logs.open', (payload: LogCommandPayload) => this.openLog(payload))
		);
	}

	dispose(): void {
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: LogNode): vscode.TreeItem {
		return element;
	}

	async getChildren(element?: LogNode): Promise<LogNode[]> {
		if (!element) {
			return Object.entries(CATEGORY_META).map(([key, meta]) => {
				const label = localize(meta.labelKey);
				const node = new LogNode('category', key as LogCategoryKey, undefined, label, vscode.TreeItemCollapsibleState.Collapsed);
				node.iconPath = new vscode.ThemeIcon(meta.iconId);
				return node;
			});
		}

		if (element.kind === 'category') {
			if (!element.category) {
				return [];
			}
			const config = this.getLogConfig();
			const baseUrl = config?.[element.category];
			if (!baseUrl) {
				const messageNode = new LogNode('message', element.category, undefined, localize('errorLog.noConfig'), vscode.TreeItemCollapsibleState.None);
				messageNode.iconPath = new vscode.ThemeIcon('info');
				return [messageNode];
			}
			const dates = this.getRecentDates();
			return dates.map((date) => {
				const node = new LogNode('log', element.category!, date, date, vscode.TreeItemCollapsibleState.None);
				node.description = localize(metaLabelKey(element.category!));
				node.tooltip = `${date}.txt`;
				node.iconPath = new vscode.ThemeIcon('file-text');
				node.command = {
					command: 'dota2tools.logs.open',
					title: localize('dota2tools.logs.open'),
					arguments: [{ category: element.category!, label: date } as LogCommandPayload]
				};
				return node;
			});
		}

		return [];
	}

	private getLogConfig(): LogConfig | undefined {
		return vscode.workspace.getConfiguration().get<LogConfig>('dota2-tools.A9.LogServer');
	}

	private getRecentDates(days = 30): string[] {
		const formatter = new Intl.DateTimeFormat('sv-SE');
		const result: string[] = [];
		const now = new Date();
		for (let i = 0; i < days; i++) {
			const date = new Date(now);
			date.setDate(now.getDate() - i);
			result.push(formatter.format(date));
		}
		return result;
	}

	private async openLog(payload: LogCommandPayload) {
		const config = this.getLogConfig();
		const baseUrl = config?.[payload.category];
		if (!baseUrl) {
			vscode.window.showWarningMessage(localize('errorLog.noConfig'));
			return;
		}

		const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
		const url = `${normalizedBase}/${payload.label}.txt`;

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: localize('errorLog.opening') }, async () => {
			try {
				const response = await axios.get<string>(url, { responseType: 'text' });
				const document = await vscode.workspace.openTextDocument({ content: response.data, language: 'plaintext' });
				await vscode.window.showTextDocument(document, { preview: false });
			} catch (error) {
				console.error('[ErrorLogTreeProvider] openLog failed', error);
				vscode.window.showErrorMessage(localize('errorLog.openFailed'));
			}
		});
	}
}

class LogNode extends vscode.TreeItem {
	constructor(
		public readonly kind: 'category' | 'log' | 'message',
		public readonly category: LogCategoryKey | undefined,
		public readonly date: string | undefined,
		label: string,
		collapsibleState: vscode.TreeItemCollapsibleState
	) {
		super(label, collapsibleState);
	}
}

function metaLabelKey(category: LogCategoryKey): string {
	return CATEGORY_META[category].labelKey;
}
