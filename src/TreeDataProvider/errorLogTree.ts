import axios from 'axios';
import * as path from 'path';
import * as vscode from 'vscode';
import { getWebviewContent } from '../utils/getWebViewContent';
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

interface AggregatedLocation {
	rawPath: string;
	line: number;
}

interface AggregatedLogEntry {
	key: string;
	message: string;
	count: number;
	resolved: boolean;
}

export class ErrorLogTreeProvider implements vscode.TreeDataProvider<LogNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<LogNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly resolvedState = new Map<string, boolean>();

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(
			vscode.commands.registerCommand('dota2tools.logs.open', (payload: LogCommandPayload) => this.openLog(payload))
		);
		this.disposables.push(
			vscode.commands.registerCommand('dota2tools.logs.refreshCategory', (node: LogNode | undefined) => this.refreshCategory(node))
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
				node.contextValue = 'errorLog.category';
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

	private getRecentDates(): string[] {
		const formatter = new Intl.DateTimeFormat('sv-SE');
		const result: string[] = [];
		const now = new Date();
		const days = this.getRecentDayCount();
		for (let i = 0; i < days; i++) {
			const date = new Date(now);
			date.setDate(now.getDate() - i);
			result.push(formatter.format(date));
		}
		return result;
	}

	private getRecentDayCount(): number {
		const rawValue = vscode.workspace.getConfiguration().get<number>('dota2-tools.A9.recentDays');
		if (rawValue === undefined || rawValue === null) {
			return 15;
		}
		const parsed = Math.floor(rawValue);
		if (!Number.isFinite(parsed) || parsed < 1) {
			return 15;
		}
		return Math.min(parsed, 90);
	}

	private async openLog(payload: LogCommandPayload) {
		const config = this.getLogConfig();
		const baseUrl = config?.[payload.category];
		if (!baseUrl) {
			vscode.window.showWarningMessage(localize('errorLog.noConfig'));
			return;
		}

		const dateParam = payload.label.replace(/-/g, '');
		let url: string;
		try {
			const urlObj = new URL(baseUrl);
			urlObj.searchParams.set('date', dateParam);
			url = urlObj.toString();
		} catch (error) {
			const hasQuery = baseUrl.includes('?');
			const needsAmpersand = hasQuery && !baseUrl.endsWith('?') && !baseUrl.endsWith('&');
			const separator = hasQuery ? (needsAmpersand ? '&' : '') : '?';
			url = `${baseUrl}${separator}date=${encodeURIComponent(dateParam)}`;
		}

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: localize('errorLog.opening') }, async () => {
			try {
				const response = await axios.get<string>(url, { responseType: 'text' });
				const aggregated = this.aggregateLogContent(payload, response.data);
				await this.renderWebview(payload, aggregated);
			} catch (error) {
				console.error('[ErrorLogTreeProvider] openLog failed', error);
				vscode.window.showErrorMessage(localize('errorLog.openFailed'));
			}
		});
	}

	private aggregateLogContent(payload: LogCommandPayload, raw: string): AggregatedLogEntry[] {
		const normalized = raw.replace(/\r\n/g, '\n');
		const blocks = normalized.split(/\n(?=\d+\|)/);
		const counter = new Map<string, number>();
		for (const block of blocks) {
			const trimmed = block.trim();
			if (!trimmed) {
				continue;
			}
			const withoutPrefix = trimmed.replace(/^\d+\|[^|]*\|/, '').trim();
			if (!withoutPrefix) {
				continue;
			}
			const message = withoutPrefix;
			const current = counter.get(message) ?? 0;
			counter.set(message, current + 1);
		}

		return Array.from(counter.entries()).map(([message, count]) => {
			const key = `${payload.category}|${message}`;
			const resolved = this.resolvedState.get(key) ?? false;
			return { key, message, count, resolved };
		}).sort((a, b) => b.count - a.count || a.message.localeCompare(b.message));
	}

	private async renderWebview(payload: LogCommandPayload, entries: AggregatedLogEntry[]) {
		const panel = vscode.window.createWebviewPanel(
			'dota2tools.errorLogSummary',
			`${localize(metaLabelKey(payload.category))} ${payload.label}`,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview')]
			}
		);
		this.disposables.push(panel);

		panel.webview.html = await getWebviewContent(panel.webview, this.context.extensionUri, 'errorLogViewer', (html) =>
			html.replace(/{{TITLE}}/g, `${localize(metaLabelKey(payload.category))} ${payload.label}`)
		);

		panel.webview.onDidReceiveMessage((message) => {
			if (message?.type === 'toggleResolved') {
				const { key, resolved } = message;
				if (typeof key === 'string' && typeof resolved === 'boolean') {
					this.resolvedState.set(key, resolved);
				}
			} else if (message?.type === 'openReference') {
				const { reference } = message;
				if (typeof reference === 'string' && reference.trim().length > 0) {
					this.handleReference(reference).catch((error: unknown) => {
						console.error('[ErrorLogTreeProvider] openReference failed', error);
						vscode.window.showErrorMessage(localize('errorLog.openFailed'));
					});
				}
			} else if (message?.type === 'openLocation') {
				const { location, reference } = message;
				if (location && typeof location.rawPath === 'string' && typeof location.line === 'number') {
					this.tryOpenLocation(location).catch((error: unknown) => {
						console.error('[ErrorLogTreeProvider] openLocation failed', error);
						vscode.window.showErrorMessage(localize('errorLog.openFailed'));
					});
				} else if (typeof reference === 'string' && reference.trim().length > 0) {
					this.handleReference(reference).catch((error: unknown) => {
						console.error('[ErrorLogTreeProvider] openReference failed', error);
						vscode.window.showErrorMessage(localize('errorLog.openFailed'));
					});
				}
			}
		});

		panel.webview.postMessage({
			type: 'logData',
			payload: {
				entries,
				date: payload.label
			}
		});
	}

	private refreshCategory(node: LogNode | undefined) {
		if (!node || node.kind !== 'category') {
			return;
		}
		this._onDidChangeTreeData.fire(node);
	}

	private async handleReference(reference: string): Promise<void> {
		const location = this.extractLocation(reference);
		if (!location) {
			vscode.window.showWarningMessage(`${localize('errorLog.locationNotFound')} ${reference}`);
			return;
		}
		await this.tryOpenLocation(location);
	}

	private extractLocation(reference: string): AggregatedLocation | undefined {
		const normalizedReference = reference.trim();
		const match = /(script[^\s:]*\.ts)(?::(\d+))?/i.exec(normalizedReference);
		if (!match) {
			return undefined;
		}
		const [, rawPath, lineStr] = match;
		const sanitizedPath = this.sanitizeRawPath(rawPath);
		if (!sanitizedPath) {
			return undefined;
		}
		let lineNumber = 1;
		if (lineStr) {
			const parsed = Number.parseInt(lineStr, 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				lineNumber = parsed;
			}
		}
		return { rawPath: sanitizedPath, line: lineNumber };
	}

	private sanitizeRawPath(rawPath: string): string {
		let result = rawPath;
		result = result.replace(/^\d+\|[^|]*\|/, '');
		result = result.replace(/\.{3}/, '');
		result = result.replace(/^\/+/, '');
		return result.trim();
	}

	private async tryOpenLocation(location: AggregatedLocation): Promise<void> {
		const uri = await this.resolveUri(location.rawPath);
		if (!uri) {
			vscode.window.showWarningMessage(`${localize('errorLog.locationNotFound')} ${location.rawPath}`);
			return;
		}

		const document = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(document, { preview: false });
		const targetLine = Math.max(0, location.line - 1);
		const clampedLine = Math.min(Math.max(targetLine, 0), Math.max(0, document.lineCount - 1));
		const lineRange = document.lineAt(clampedLine).range;
		editor.selection = new vscode.Selection(lineRange.start, lineRange.start);
		editor.revealRange(lineRange, vscode.TextEditorRevealType.InCenter);
	}

	private async resolveUri(rawPath: string): Promise<vscode.Uri | undefined> {
		const candidates = this.expandPathCandidates(rawPath);
		const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
		const visited = new Set<string>();

		for (const candidate of candidates) {
			for (const variant of this.expandExtensionVariants(candidate)) {
				if (!variant || visited.has(variant)) {
					continue;
				}
				visited.add(variant);

				const normalizedVariant = variant.replace(/\\/g, path.sep);
				if (path.isAbsolute(normalizedVariant)) {
					const uri = vscode.Uri.file(path.normalize(normalizedVariant));
					if (await this.pathExists(uri)) {
						return uri;
					}
					continue;
				}

				for (const folder of workspaceFolders) {
					const absolute = path.join(folder.uri.fsPath, normalizedVariant);
					const uri = vscode.Uri.file(path.normalize(absolute));
					if (await this.pathExists(uri)) {
						return uri;
					}
				}

				const basename = path.basename(normalizedVariant);
				if (basename) {
					const found = await vscode.workspace.findFiles(`**/${basename}`, undefined, 5);
					for (const uri of found) {
						const endsWithVariant = uri.fsPath.replace(/\\/g, '/').endsWith(normalizedVariant.replace(/\\/g, '/'));
						if (endsWithVariant) {
							return uri;
						}
					}
				}
			}
		}

		return undefined;
	}

	private expandPathCandidates(rawPath: string): string[] {
		const normalized = rawPath.replace(/\\/g, '/');
		const variants = new Set<string>();
		variants.add(normalized);

		const colonParts = normalized.split(':');
		if (colonParts.length > 1) {
			for (let i = 1; i < colonParts.length; i++) {
				variants.add(colonParts.slice(i).join(':'));
			}
		}

		const scriptsMatch = normalized.match(/(?:^|\/)(scripts\/.*)$/);
		if (scriptsMatch) {
			variants.add(scriptsMatch[1]);
		}

		const srcMatch = normalized.match(/(?:^|\/)(src\/.*)$/);
		if (srcMatch) {
			variants.add(srcMatch[1]);
		}

		variants.add(normalized.replace(/^\/+/, ''));
		variants.add(normalized.replace(/^\.\//, ''));

		return Array.from(variants).filter(Boolean);
	}

	private expandExtensionVariants(candidate: string): string[] {
		const variants = new Set<string>();
		variants.add(candidate);
		if (candidate.endsWith('.lua')) {
			variants.add(candidate.slice(0, -4) + '.ts');
		}
		if (candidate.endsWith('.ts')) {
			variants.add(candidate.slice(0, -3) + '.lua');
		}
		return Array.from(variants);
	}

	private async pathExists(uri: vscode.Uri): Promise<boolean> {
		try {
			await vscode.workspace.fs.stat(uri);
			return true;
		} catch {
			return false;
		}
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
