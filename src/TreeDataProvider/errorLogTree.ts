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

interface LogApiItem {
	id: number;
	project: string;
	error_level: string;
	brief: string;
	count: number;
	uids: string;
	origin_message: string;
	fix_status: number;
	first_time: number;
	last_time: number;
}

interface LogApiResponse {
	code?: number;
	data?: LogApiItem[];
}

interface AggregatedLogEntry {
	id: number;
	key: string;
	message: string;
	count: number;
	resolved: boolean;
	origin: string;
	uids: string;
	firstTime: number;
	lastTime: number;
	summary?: string;
}

interface DateProgress {
	resolved: number;
	total: number;
}

type TreeViewWithBadge<T> = vscode.TreeView<T> & { badge?: { value: number; tooltip: string; }; };

export class ErrorLogTreeProvider implements vscode.TreeDataProvider<LogNode>, vscode.Disposable {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<LogNode | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly resolvedState = new Map<string, boolean>();
	private readonly progressCache = new Map<string, DateProgress>();
	private readonly entriesCache = new Map<string, AggregatedLogEntry[]>();
	private readonly progressRequests = new Map<string, Promise<void>>();
	private readonly resolvedCompleteIcon: { light: vscode.Uri; dark: vscode.Uri; };
	private treeView: TreeViewWithBadge<LogNode> | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(
			vscode.commands.registerCommand('dota2tools.logs.open', (payload: LogCommandPayload) => this.openLog(payload))
		);
		this.disposables.push(
			vscode.commands.registerCommand('dota2tools.logs.refreshCategory', (node: LogNode | undefined) => this.refreshCategory(node))
		);
		this.resolvedCompleteIcon = {
			light: vscode.Uri.joinPath(context.extensionUri, 'images', 'check_green.svg'),
			dark: vscode.Uri.joinPath(context.extensionUri, 'images', 'check_green.svg')
		};
	}

	attachTreeView(treeView: vscode.TreeView<LogNode>): void {
		this.treeView = treeView as TreeViewWithBadge<LogNode>;
		this.updateTreeBadge();
	}

	prefetchYesterdayCounts(): void {
		const primaryDate = this.getPrimaryDate();
		if (!primaryDate) {
			this.updateTreeBadge();
			return;
		}
		const config = this.getLogConfig();
		if (!config) {
			this.updateTreeBadge();
			return;
		}
		let requested = false;
		for (const category of Object.keys(CATEGORY_META) as LogCategoryKey[]) {
			const baseUrl = config[category];
			if (!baseUrl) {
				continue;
			}
			this.ensureProgressPrefetch(category, primaryDate, baseUrl);
			requested = true;
		}
		if (!requested) {
			this.updateTreeBadge();
		}
	}

	dispose(): void {
		while (this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
	}

	refresh(): void {
		this.progressCache.clear();
		this.entriesCache.clear();
		this.progressRequests.clear();
		this.updateTreeBadge();
		this._onDidChangeTreeData.fire(undefined);
		this.prefetchYesterdayCounts();
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
			if (dates.length > 0) {
				this.ensureProgressPrefetch(element.category!, dates[0], baseUrl);
			}
			return dates.map((date) => {
				const node = new LogNode('log', element.category!, date, date, vscode.TreeItemCollapsibleState.None);
				node.description = this.buildDateDescription(element.category!, date);
				node.tooltip = `${date}.txt`;
				const progressKey = this.progressKey(element.category!, date);
				const progress = this.progressCache.get(progressKey);
				if (progress && progress.total > 0 && progress.resolved >= progress.total) {
					node.iconPath = this.resolvedCompleteIcon;
				} else {
					node.iconPath = new vscode.ThemeIcon('file-text');
				}
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
			date.setDate(now.getDate() - (i + 1));
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

	private computeDateRange(label: string): { start: number; end: number; } {
		const parsed = Date.parse(`${label}T00:00:00Z`);
		if (!Number.isFinite(parsed)) {
			const now = new Date();
			const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const start = Math.floor(startOfDay.getTime() / 1000);
			return { start, end: start + 86400 - 1 };
		}
		const start = Math.floor(parsed / 1000);
		return { start, end: start + 86400 - 1 };
	}

	private createResolvedKey(category: LogCategoryKey, id: number): string {
		return `${category}:${id}`;
	}

	private async openLog(payload: LogCommandPayload) {
		const config = this.getLogConfig();
		const baseUrl = config?.[payload.category];
		if (!baseUrl) {
			vscode.window.showWarningMessage(localize('errorLog.noConfig'));
			return;
		}

		await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: localize('errorLog.opening') }, async () => {
			try {
				const entries = await this.fetchLogEntries(baseUrl, payload);
				this.storeEntries(payload, entries);
				await this.renderWebview(payload, entries);
			} catch (error) {
				console.error('[ErrorLogTreeProvider] openLog failed', error);
				vscode.window.showErrorMessage(localize('errorLog.openFailed'));
			}
		});
	}

	private async fetchLogEntries(baseUrl: string, payload: LogCommandPayload): Promise<AggregatedLogEntry[]> {
		const { start, end } = this.computeDateRange(payload.label);
		let url: string;
		try {
			const urlObj = new URL(baseUrl);
			urlObj.searchParams.set('start_time', String(start));
			urlObj.searchParams.set('end_time', String(end));
			urlObj.searchParams.set('fix_status', '-1');
			url = urlObj.toString();
		} catch (error) {
			const hasQuery = baseUrl.includes('?');
			const needsAmpersand = hasQuery && !baseUrl.endsWith('?') && !baseUrl.endsWith('&');
			const separator = hasQuery ? (needsAmpersand ? '&' : '') : '?';
			const params = new URLSearchParams({ start_time: String(start), end_time: String(end), fix_status: '-1' }).toString();
			url = `${baseUrl}${separator}${params}`;
		}
		const response = await axios.get<LogApiResponse>(url, { responseType: 'json' });
		return this.transformLogResponse(payload, response.data);
	}

	private storeEntries(payload: LogCommandPayload, entries: AggregatedLogEntry[]): void {
		const key = this.progressKey(payload.category, payload.label);
		const clonedEntries = entries.map((entry) => ({ ...entry }));
		this.entriesCache.set(key, clonedEntries);
		this.updateProgressFromEntries(payload.category, payload.label, clonedEntries);
	}

	private ensureProgressPrefetch(category: LogCategoryKey, date: string, baseUrl: string): void {
		const key = this.progressKey(category, date);
		if (this.progressCache.has(key) || this.progressRequests.has(key)) {
			return;
		}
		const payload: LogCommandPayload = { category, label: date };
		const request = this.fetchLogEntries(baseUrl, payload)
			.then((entries) => {
				this.storeEntries(payload, entries);
			})
			.catch((error) => {
				console.warn('[ErrorLogTreeProvider] ensureProgressPrefetch failed', error);
			})
			.finally(() => {
				this.progressRequests.delete(key);
				this.updateTreeBadge();
			});
		this.progressRequests.set(key, request);
	}

	private buildDateDescription(category: LogCategoryKey, date: string): string {
		const baseLabel = localize(metaLabelKey(category));
		const key = this.progressKey(category, date);
		const progress = this.progressCache.get(key);
		if (!progress) {
			return baseLabel;
		}
		return `${baseLabel} ${this.formatProgress(progress)}`;
	}

	private formatProgress(progress: DateProgress): string {
		return `[${progress.resolved}/${progress.total}]`;
	}

	private updateProgressFromEntries(category: LogCategoryKey, date: string, entries: AggregatedLogEntry[]): void {
		const key = this.progressKey(category, date);
		const progress = this.calculateProgress(entries);
		const previous = this.progressCache.get(key);
		const changed = !previous || previous.resolved !== progress.resolved || previous.total !== progress.total;
		this.progressCache.set(key, progress);
		if (changed) {
			this._onDidChangeTreeData.fire(undefined);
		}
	}

	private calculateProgress(entries: AggregatedLogEntry[]): DateProgress {
		let total = 0;
		let resolved = 0;
		for (const entry of entries) {
			const count = Number.isFinite(entry.count) ? entry.count : 0;
			total += count;
			if (entry.resolved) {
				resolved += count;
			}
		}
		return { resolved, total };
	}

	private progressKey(category: LogCategoryKey, date: string): string {
		return `${category}:${date}`;
	}

	private updateCachedEntryResolution(payload: LogCommandPayload, id: number, resolved: boolean): void {
		const key = this.progressKey(payload.category, payload.label);
		const cachedEntries = this.entriesCache.get(key);
		if (!cachedEntries) {
			return;
		}
		const target = cachedEntries.find((entry) => entry.id === id);
		if (!target) {
			return;
		}
		if (target.resolved === resolved) {
			return;
		}
		target.resolved = resolved;
		this.updateProgressFromEntries(payload.category, payload.label, cachedEntries);
	}

	private updateTreeBadge(): void {
		if (!this.treeView) {
			return;
		}
		const primaryDate = this.getPrimaryDate();
		if (!primaryDate) {
			this.treeView.badge = undefined;
			return;
		}
		let hasProgress = false;
		let unresolvedTotal = 0;
		for (const [key, progress] of this.progressCache.entries()) {
			const [, date] = key.split(':');
			if (date !== primaryDate) {
				continue;
			}
			hasProgress = true;
			const unresolved = progress.total - progress.resolved;
			unresolvedTotal += Math.max(unresolved, 0);
		}
		if (!hasProgress) {
			this.treeView.badge = undefined;
			return;
		}
		const tooltip = `${localize('errorLog.yesterdayBadgeTooltip')} ${unresolvedTotal}`.trim();
		this.treeView.badge = {
			value: unresolvedTotal,
			tooltip
		};
	}

	private getPrimaryDate(): string | undefined {
		const dates = this.getRecentDates();
		return dates.length > 0 ? dates[0] : undefined;
	}

	private transformLogResponse(payload: LogCommandPayload, response: LogApiResponse | undefined): AggregatedLogEntry[] {
		if (!response) {
			return [];
		}
		if (typeof response.code === 'number' && response.code !== 0) {
			console.warn('[ErrorLogTreeProvider] API returned non-zero code', response.code);
		}
		const items = Array.isArray(response.data) ? response.data : [];
		const result: AggregatedLogEntry[] = [];
		for (const item of items) {
			const id = Number(item.id);
			if (!Number.isFinite(id)) {
				continue;
			}
			const key = this.createResolvedKey(payload.category, id);
			const resolvedState = this.resolvedState.get(key);
			const originMessage = ((item.origin_message ?? item.brief ?? '') as string).trim();
			const summaryMessage = ((item.brief ?? '') as string).trim();
			const countValue = Number(item.count ?? 0);
			const firstTimeValue = Number(item.first_time ?? 0);
			const lastTimeValue = Number(item.last_time ?? 0);
			result.push({
				id,
				key,
				message: originMessage,
				count: Number.isFinite(countValue) ? countValue : 0,
				resolved: resolvedState ?? item.fix_status === 1,
				origin: originMessage,
				uids: item.uids ?? '',
				firstTime: Number.isFinite(firstTimeValue) ? firstTimeValue : 0,
				lastTime: Number.isFinite(lastTimeValue) ? lastTimeValue : 0,
				summary: summaryMessage
			});
		}
		return result.sort((a, b) => {
			if (b.count !== a.count) {
				return b.count - a.count;
			}
			if (b.lastTime !== a.lastTime) {
				return b.lastTime - a.lastTime;
			}
			return (a.summary ?? a.message).localeCompare(b.summary ?? b.message);
		});
	}

	private async renderWebview(payload: LogCommandPayload, entries: AggregatedLogEntry[]) {
		const panel = vscode.window.createWebviewPanel(
			'dota2tools.errorLogSummary',
			`${localize(metaLabelKey(payload.category))} ${payload.label}`,
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				enableFindWidget: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'webview')]
			}
		);
		this.disposables.push(panel);

		panel.webview.html = await getWebviewContent(panel.webview, this.context.extensionUri, 'errorLogViewer', (html) =>
			html.replace(/{{TITLE}}/g, `${localize(metaLabelKey(payload.category))} ${payload.label}`)
		);

		panel.webview.onDidReceiveMessage(async (message) => {
			try {
				if (message?.type === 'toggleResolved') {
					const { id, resolved } = message;
					if (typeof id === 'number' && typeof resolved === 'boolean') {
						await this.handleToggleResolved(panel, payload, id, resolved);
					}
				} else if (message?.type === 'openReference') {
					const { reference } = message;
					if (typeof reference === 'string' && reference.trim().length > 0) {
						await this.handleReference(reference);
					}
				} else if (message?.type === 'openLocation') {
					const { location, reference } = message;
					if (location && typeof location.rawPath === 'string' && typeof location.line === 'number') {
						await this.tryOpenLocation(location);
					} else if (typeof reference === 'string' && reference.trim().length > 0) {
						await this.handleReference(reference);
					}
				}
			} catch (error) {
				console.error('[ErrorLogTreeProvider] message handling failed', error);
				vscode.window.showErrorMessage(localize('errorLog.openFailed'));
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

	private async handleToggleResolved(panel: vscode.WebviewPanel, payload: LogCommandPayload, id: number, resolved: boolean): Promise<void> {
		const key = this.createResolvedKey(payload.category, id);
		if (!resolved) {
			this.resolvedState.set(key, false);
			this.updateCachedEntryResolution(payload, id, false);
			await panel.webview.postMessage({ type: 'resolveStatusUpdate', id, resolved: false, success: true });
			return;
		}

		try {
			await this.markEntriesAsFixed(payload.category, [id]);
			this.resolvedState.set(key, true);
			this.updateCachedEntryResolution(payload, id, true);
			await panel.webview.postMessage({ type: 'resolveStatusUpdate', id, resolved: true, success: true });
		} catch (error) {
			console.error('[ErrorLogTreeProvider] markEntriesAsFixed failed', error);
			this.resolvedState.set(key, false);
			this.updateCachedEntryResolution(payload, id, false);
			await panel.webview.postMessage({ type: 'resolveStatusUpdate', id, resolved: false, success: false });
			vscode.window.showErrorMessage(localize('errorLog.fixFailed'));
		}
	}

	private async markEntriesAsFixed(category: LogCategoryKey, ids: number[]): Promise<void> {
		if (!ids.length) {
			return;
		}
		const config = this.getLogConfig();
		const baseUrl = config?.[category];
		if (!baseUrl) {
			throw new Error('Missing log server configuration for category');
		}
		const fixUrl = this.buildFixUrl(baseUrl);
		await axios.post(fixUrl, { ids }, { headers: { 'Content-Type': 'application/json' } });
	}

	private buildFixUrl(baseUrl: string): string {
		try {
			const url = new URL(baseUrl);
			const segments = url.pathname.split('/').filter(Boolean);
			if (segments.length >= 2) {
				segments[segments.length - 1] = 'fix';
			} else if (segments.length === 1) {
				segments.push('fix');
			} else {
				segments.push('log', 'fix');
			}
			url.pathname = `/${segments.join('/')}`;
			url.search = '';
			url.hash = '';
			return url.toString();
		} catch {
			const [prefix] = baseUrl.split('?');
			if (prefix.endsWith('/log/get')) {
				return `${prefix.slice(0, -3)}fix`;
			}
			if (/\/log\/[^/]+$/i.test(prefix)) {
				return prefix.replace(/\/log\/[^/]+$/i, '/log/fix');
			}
			if (prefix.endsWith('/get')) {
				return `${prefix.slice(0, -3)}fix`;
			}
			return `${prefix}/log/fix`;
		}
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

export class LogNode extends vscode.TreeItem {
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
