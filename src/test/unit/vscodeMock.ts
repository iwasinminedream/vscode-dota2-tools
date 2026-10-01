/**
 * Minimal stand-in for the `vscode` module so extension code can be unit-tested in plain Node.
 * setup.ts redirects `require('vscode')` here. Only what the tested modules touch is implemented;
 * calls are recorded in `state` for assertions.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

export const state = {
	config: {} as { [key: string]: unknown; },
	clipboardText: '',
	messages: [] as { level: 'info' | 'warning' | 'error'; text: string; }[],
	executedCommands: [] as { command: string; args: unknown[]; }[],
	openedExternal: [] as string[],
	workspaceFolders: undefined as { uri: Uri; name: string; index: number; }[] | undefined,
};

export function resetMock() {
	state.config = {};
	state.clipboardText = '';
	state.messages = [];
	state.executedCommands = [];
	state.openedExternal = [];
	state.workspaceFolders = undefined;
}

export class Uri {
	private constructor(readonly scheme: string, readonly fsPath: string) { }
	static file(fsPath: string) {
		return new Uri('file', fsPath);
	}
	static parse(value: string) {
		if (value.startsWith('file:')) {
			return new Uri('file', fileURLToPath(value));
		}
		return new Uri(value.split(':')[0], value);
	}
	static joinPath(base: Uri, ...segments: string[]) {
		return new Uri(base.scheme, path.join(base.fsPath, ...segments));
	}
	get path() {
		return this.fsPath.replace(/\\/g, '/');
	}
	toString() {
		return this.scheme === 'file' ? pathToFileURL(this.fsPath).toString() : this.fsPath;
	}
}

export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }

function fileTypeOf(fullPath: string, entry: fs.Dirent): number {
	if (entry.isSymbolicLink()) {
		try {
			return FileType.SymbolicLink | (fs.statSync(fullPath).isDirectory() ? FileType.Directory : FileType.File);
		} catch {
			return FileType.SymbolicLink;
		}
	}
	return entry.isDirectory() ? FileType.Directory : FileType.File;
}

const noopDisposable = { dispose() { } };
const noopEvent = () => noopDisposable;

export const workspace = {
	getConfiguration(section?: string) {
		const fullKey = (key: string) => (section ? `${section}.${key}` : key);
		return {
			get<T>(key: string, defaultValue?: T): T | undefined {
				const k = fullKey(key);
				return (k in state.config ? state.config[k] : defaultValue) as T | undefined;
			},
			has: (key: string) => fullKey(key) in state.config,
			update: async (key: string, value: unknown) => { state.config[fullKey(key)] = value; },
			inspect: () => undefined,
		};
	},
	get workspaceFolders() {
		return state.workspaceFolders;
	},
	fs: {
		async readDirectory(uri: Uri): Promise<[string, number][]> {
			return fs.readdirSync(uri.fsPath, { withFileTypes: true })
				.map((entry) => [entry.name, fileTypeOf(path.join(uri.fsPath, entry.name), entry)] as [string, number]);
		},
		async readFile(uri: Uri) {
			return new Uint8Array(fs.readFileSync(uri.fsPath));
		},
		async writeFile(uri: Uri, content: Uint8Array) {
			fs.writeFileSync(uri.fsPath, content);
		},
	},
	onDidChangeConfiguration: noopEvent,
	onDidChangeWorkspaceFolders: noopEvent,
	onDidSaveTextDocument: noopEvent,
	onDidOpenTextDocument: noopEvent,
	onDidChangeTextDocument: noopEvent,
	createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() { } }),
	textDocuments: [] as unknown[],
};

function recordMessage(level: 'info' | 'warning' | 'error') {
	return (text: string, ..._items: unknown[]) => {
		state.messages.push({ level, text });
		return Promise.resolve(undefined);
	};
}

export enum StatusBarAlignment { Left = 1, Right = 2 }

export const window = {
	showInformationMessage: recordMessage('info'),
	showWarningMessage: recordMessage('warning'),
	showErrorMessage: recordMessage('error'),
	createStatusBarItem: () => ({
		text: '', tooltip: '' as unknown, command: undefined as unknown, backgroundColor: undefined as unknown,
		show() { }, hide() { }, dispose() { },
	}),
	createOutputChannel: () => ({ append() { }, appendLine() { }, show() { }, clear() { }, dispose() { } }),
	setStatusBarMessage: () => noopDisposable,
	registerCustomEditorProvider: () => noopDisposable,
	registerTreeDataProvider: () => noopDisposable,
	registerWebviewViewProvider: () => noopDisposable,
	onDidChangeActiveTextEditor: noopEvent,
	activeTextEditor: undefined as unknown,
	visibleTextEditors: [] as unknown[],
};

export const commands = {
	async executeCommand(command: string, ...args: unknown[]) {
		state.executedCommands.push({ command, args });
		return undefined;
	},
	registerCommand: () => noopDisposable,
};

export const env = {
	language: 'en',
	clipboard: {
		readText: async () => state.clipboardText,
		writeText: async (text: string) => { state.clipboardText = text; },
	},
	async openExternal(uri: Uri) {
		state.openedExternal.push(uri.fsPath);
		return true;
	},
};

export const languages = {
	registerCompletionItemProvider: () => noopDisposable,
	registerDefinitionProvider: () => noopDisposable,
	registerHoverProvider: () => noopDisposable,
};

export const extensions = { getExtension: () => undefined };

export class Disposable {
	constructor(private readonly callOnDispose: () => void) { }
	static from(...disposables: { dispose(): unknown; }[]) {
		return new Disposable(() => disposables.forEach((d) => d.dispose()));
	}
	dispose() {
		this.callOnDispose();
	}
}

export class EventEmitter<T> {
	event = (_listener: (e: T) => unknown) => noopDisposable;
	fire(_data?: T) { }
	dispose() { }
}

export class ThemeColor { constructor(readonly id: string) { } }
export class ThemeIcon { constructor(readonly id: string) { } }
export class MarkdownString {
	constructor(public value = '') { }
	appendMarkdown(value: string) { this.value += value; return this; }
	appendText(value: string) { this.value += value; return this; }
	appendCodeblock(value: string) { this.value += value; return this; }
}
export class SnippetString { constructor(readonly value: string) { } }
export class Position { constructor(readonly line: number, readonly character: number) { } }
export class Range { constructor(readonly start: Position, readonly end: Position) { } }
export class Selection extends Range { }
export class Location { constructor(readonly uri: Uri, readonly range: Range) { } }
export class CompletionItem { constructor(readonly label: string, readonly kind?: number) { } }
export class TreeItem { constructor(readonly label: string, readonly collapsibleState?: number) { } }
export enum CompletionItemKind { Text = 0, Method = 1, Function = 2, Field = 4, Variable = 5, Class = 6, Module = 8, Property = 9, Enum = 12, Keyword = 13, Snippet = 14, File = 16, Folder = 18, EnumMember = 19, Constant = 20, Event = 22 }
export enum TreeItemCollapsibleState { None = 0, Collapsed = 1, Expanded = 2 }
export enum ViewColumn { Active = -1, Beside = -2, One = 1, Two = 2 }
export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
