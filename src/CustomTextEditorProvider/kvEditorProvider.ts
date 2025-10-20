import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KvFolderType, getKvFolderTypeForUri, readKvEditorSettings } from '../module/kvEditorConfig';
import { getWebviewContent } from '../utils/getWebViewContent';
import { readKeyValue2, writeKeyValue } from '../utils/kvUtils';

export class kvEditorProvider implements vscode.CustomTextEditorProvider {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(kvEditorProvider.viewType, new kvEditorProvider(context));
	}

	private static readonly viewType = 'dota2tools.kv';

	constructor(
		private readonly context: vscode.ExtensionContext
	) {
		this.columnOptionConfig = this.readColumnOptionConfig();
	}

	private readonly columnOptionConfig: KvEditorColumnOptionMap;

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = await getWebviewContent(webviewPanel.webview, this.context.extensionUri, 'KvEditor');

		let webviewReady = false;
		let pendingPayload: KvEditorPayload | undefined;

		const postPayload = (payload: KvEditorPayload) => {
			if (!webviewReady) {
				pendingPayload = payload;
				return;
			}
			webviewPanel.webview.postMessage({ type: 'update', payload });
		};

		const updateWebview = () => {
			postPayload(this.buildPayload(document));
		};

		const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.toString() === document.uri.toString()) {
				updateWebview();
			}
		});

		const messageListener = webviewPanel.webview.onDidReceiveMessage((message) => {
			if (!message || typeof message.type !== 'string') {
				return;
			}
			if (message.type === 'ready') {
				webviewReady = true;
				if (pendingPayload) {
					postPayload(pendingPayload);
					pendingPayload = undefined;
				} else {
					updateWebview();
				}
				return;
			}
			if (message.type === 'edit') {
				const editMessage: KvEditorEditMessage | undefined = message.payload;
				this.handleEditMessage(document, editMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
			}
		});

		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
			messageListener.dispose();
		});

		updateWebview();
	}

	private buildPayload(document: vscode.TextDocument): KvEditorPayload {
		const settings = readKvEditorSettings();
		const folderType = getKvFolderTypeForUri(document.uri, settings);
		const parsed = this.parseKv(document.getText());
		return {
			fileName: path.basename(document.uri.fsPath),
			folderType,
			header: parsed.header,
			columns: parsed.columns,
			rows: parsed.rows,
			error: parsed.error,
			columnOptions: this.columnOptionConfig,
		};
	}

	private readColumnOptionConfig(): KvEditorColumnOptionMap {
		try {
			const configPath = this.context.asAbsolutePath(path.join('resource', 'kv_editor_field_options.json'));
			const raw = fs.readFileSync(configPath, 'utf8');
			const parsed = JSON.parse(raw) as Record<string, unknown> | undefined;
			if (!parsed || typeof parsed !== 'object') {
				return {};
			}
			const result: KvEditorColumnOptionMap = {};
			for (const [column, value] of Object.entries(parsed)) {
				if (!value || typeof value !== 'object') {
					continue;
				}
				const optionsRaw = (value as Record<string, unknown>).options;
				if (!Array.isArray(optionsRaw)) {
					continue;
				}
				const options: KvEditorColumnOption[] = optionsRaw
					.map((optionEntry) => {
						if (!optionEntry || typeof optionEntry !== 'object') {
							return undefined;
						}
						const rawValue = (optionEntry as Record<string, unknown>).value;
						if (typeof rawValue !== 'string') {
							return undefined;
						}
						const rawLabel = (optionEntry as Record<string, unknown>).label;
						const rawDescription = (optionEntry as Record<string, unknown>).description;
						const option: KvEditorColumnOption = {
							value: rawValue,
							label: typeof rawLabel === 'string' && rawLabel.length > 0 ? rawLabel : rawValue,
						};
						if (typeof rawDescription === 'string' && rawDescription.length > 0) {
							option.description = rawDescription;
						}
						return option;
					})
					.filter((entry): entry is KvEditorColumnOption => Boolean(entry));
				if (!options.length) {
					continue;
				}
				const multiple = Boolean((value as Record<string, unknown>).multiple);
				const separatorRaw = (value as Record<string, unknown>).separator;
				const separator = typeof separatorRaw === 'string' && separatorRaw.length > 0 ? separatorRaw : ',';
				result[column] = { options, multiple, separator };
			}
			return result;
		} catch (error) {
			console.warn('[kvEditorProvider] Failed to read column option config:', error);
			return {};
		}
	}

	private parseKv(text: string): ParsedKvTable {
		try {
			const kvObject = readKeyValue2(text ?? '');
			const header = Object.keys(kvObject)[0] ?? '';
			const block = header ? kvObject[header] : undefined;
			if (!block || typeof block !== 'object') {
				return { header, columns: [], rows: [] };
			}

			const columnOrder: string[] = [];
			const rows = Object.entries(block)
				.filter(([_, value]) => value && typeof value === 'object')
				.map(([id, value]) => {
					const entry = value as Record<string, unknown>;
					const rowValues: Record<string, string> = {};
					for (const [key, field] of Object.entries(entry)) {
						if (field && typeof field === 'object') {
							// nested blocks (e.g. AbilityValues) are intentionally skipped until dedicated UI exists
							continue;
						}
						if (!columnOrder.includes(key)) {
							columnOrder.push(key);
						}
						rowValues[key] = field === undefined || field === null ? '' : String(field);
					}
					return { id, values: rowValues };
				});

			const columns = ['id', ...columnOrder];
			return { header, columns, rows };
		} catch (error) {
			return {
				header: '',
				columns: [],
				rows: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async handleEditMessage(document: vscode.TextDocument, message?: KvEditorEditMessage): Promise<void> {
		if (!message || !message.id || !message.key || message.key === 'id') {
			return;
		}
		const originalText = document.getText();
		const kvObject = readKeyValue2(originalText ?? '');
		const header = Object.keys(kvObject)[0];
		if (!header) {
			throw new Error('无法解析 KV 根节点，修改未保存。');
		}
		const block = kvObject[header];
		if (!block || typeof block !== 'object') {
			throw new Error('当前 KV 结构不支持直接编辑。');
		}
		const row = (block as Record<string, unknown>)[message.id];
		if (!row || typeof row !== 'object') {
			throw new Error(`未找到条目 "${message.id}"，修改未保存。`);
		}
		const normalizedKey = message.key;
		const normalizedValue = message.value === undefined || message.value === null ? '' : String(message.value);
		const record = row as Record<string, unknown>;
		const previousValue = record[normalizedKey];
		if ((previousValue === undefined || previousValue === null ? '' : String(previousValue)) === normalizedValue) {
			return;
		}
		record[normalizedKey] = normalizedValue;
		const newContent = writeKeyValue(kvObject);
		const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(originalText.length));
		const edit = new vscode.WorkspaceEdit();
		edit.replace(document.uri, fullRange, newContent);
		const applied = await vscode.workspace.applyEdit(edit);
		if (!applied) {
			throw new Error('写入 KV 文本失败。');
		}
		const autoSaveMode = vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off');
		if (autoSaveMode && autoSaveMode !== 'off') {
			const saved = await document.save();
			if (!saved) {
				throw new Error('保存 KV 文件失败。');
			}
		}
	}

}

interface KvEditorPayload {
	fileName: string;
	folderType: KvFolderType;
	header: string;
	columns: string[];
	rows: Array<{ id: string; values: Record<string, string>; }>;
	error?: string;
	columnOptions: KvEditorColumnOptionMap;
}

interface ParsedKvTable {
	header: string;
	columns: string[];
	rows: Array<{ id: string; values: Record<string, string>; }>;
	error?: string;
}

interface KvEditorEditMessage {
	id: string;
	key: string;
	value: string;
}

interface KvEditorColumnOption {
	value: string;
	label: string;
	description?: string;
}

interface KvEditorColumnOptionConfig {
	options: KvEditorColumnOption[];
	multiple: boolean;
	separator: string;
}

type KvEditorColumnOptionMap = Record<string, KvEditorColumnOptionConfig>;