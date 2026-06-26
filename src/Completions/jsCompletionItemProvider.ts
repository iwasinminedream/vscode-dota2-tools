import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { DotaApiNote } from '../Class/DotaApiNote';

interface JsFunction {
	Function?: string;
	Signature?: string;
	Description?: string;
	Value?: string;
	Enumerator?: string;
}

const DOTA_LABEL = 'Dota2 Panorama';

/** Priority class ordering - the earlier the entry, the higher the priority */
const PRIORITY_CLASSES = ['$', 'Game', 'Players', 'GameUI', 'Entities', 'Abilities', 'Items', 'Buffs', 'GameEvents', 'CustomNetTables', 'Particles'];

function classSortPrefix(shortName: string): string {
	const idx = PRIORITY_CLASSES.indexOf(shortName);
	if (idx >= 0) {
		return String(idx).padStart(2, '0');
	}
	return '99';
}

export class JsCompletionItemProvider implements vscode.CompletionItemProvider {
	selector: vscode.DocumentSelector;
	triggerCharacters: string[] = ['.'];
	document: {
		[key: string]: { [key: string]: JsFunction };
	};
	/** Global completion list (class names + functions + enums) - non-dot context */
	globalSnippets: vscode.CompletionItem[];
	/** Method completions grouped by short class name (e.g. "Game" -> [Time, GetGameTime, ...]) - dot context */
	classMethodMap: Map<string, vscode.CompletionItem[]>;
	/** Lowercase short class name -> correct-case mapping (game -> Game, gameevents -> GameEvents) */
	classNameNormalize: Map<string, string>;

	constructor(context: vscode.ExtensionContext, public dotaApiNote: DotaApiNote) {
		this.selector = [
			{ scheme: 'file', language: 'javascript' },
			{ scheme: 'file', language: 'typescript' },
			{ scheme: 'untitled', language: 'javascript' },
			{ scheme: 'untitled', language: 'typescript' },
		];
		this.document = JSON.parse(fs.readFileSync(path.join(context.extensionPath, 'resource', 'cl_panorama_script_help_2.json'), 'utf-8'));
		this.globalSnippets = [];
		this.classMethodMap = new Map();
		this.classNameNormalize = new Map();

		const classShortNames = new Set<string>();
		/** Dedup: global-context function name -> already added */
		const globalFunctionAdded = new Set<string>();

		for (const className in this.document) {
			const classData = this.document[className];
			// Extract the short class name from the first function signature (e.g. "GameEvents.Subscribe(...)" -> "GameEvents")
			let shortName = className;
			for (const funName in classData) {
				const funInfo = classData[funName];
				if (funInfo.Signature) {
					const dotIdx = funInfo.Signature.indexOf('.');
					if (dotIdx > 0) {
						shortName = funInfo.Signature.substring(0, dotIdx);
					}
				}
				break;
			}

			const isDollarClass = shortName === '$';
			const classPriority = classSortPrefix(shortName);

			// Class name completion (e.g. $, Game, GameEvents, Particles)
			if (!classShortNames.has(shortName)) {
				classShortNames.add(shortName);
				this.classNameNormalize.set(shortName.toLowerCase(), shortName);
				let classItem = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Class);
				classItem.detail = `${DOTA_LABEL} — ${className}`;
				classItem.sortText = `!0_${classPriority}_${shortName}`;
				this.globalSnippets.push(classItem);
			}

			/** Dedup: dot-context method name -> already added (within the same shortName) */
			const existingMethods = this.classMethodMap.get(shortName);
			const dotMethodAdded = new Set<string>();
			if (existingMethods) {
				existingMethods.forEach(item => dotMethodAdded.add(item.label as string));
			}

			const methodItems: vscode.CompletionItem[] = existingMethods || [];

			for (const funName in classData) {
				let funInfo = classData[funName];
				if (funInfo.Function) {
					// ===== dot context (Game. -> Time): dedup within the same shortName =====
					if (!dotMethodAdded.has(funName)) {
						dotMethodAdded.add(funName);
						let dotItem = new vscode.CompletionItem(funName, vscode.CompletionItemKind.Method);
						dotItem.detail = `${DOTA_LABEL} — ${funInfo.Description || ''}`;
						dotItem.documentation = this.getDocumentation(funInfo, shortName);
						dotItem.insertText = this.buildMethodSnippet(funInfo, isDollarClass);
						dotItem.sortText = `0_${funName}`;
						methodItems.push(dotItem);
					}

					// ===== global context (time -> Game.Time()): keep only one =====
					if (!globalFunctionAdded.has(funName)) {
						globalFunctionAdded.add(funName);
						const displayPrefix = shortName + '.';
						let globalItem = new vscode.CompletionItem(
							{ label: funName, description: displayPrefix + funName },
							vscode.CompletionItemKind.Method
						);
						globalItem.detail = `${DOTA_LABEL}`;
						globalItem.documentation = this.getDocumentation(funInfo, shortName);
						globalItem.insertText = this.buildFullSnippet(funInfo, shortName, isDollarClass);
						globalItem.filterText = funName;
						globalItem.sortText = `!1_${classPriority}_${funName}`;
						this.globalSnippets.push(globalItem);
					}
				}
				else if (funInfo.Enumerator) {
					let item = new vscode.CompletionItem(funName, vscode.CompletionItemKind.Enum);
					item.detail = `${DOTA_LABEL} — ${funInfo.Value || ''}`;
					item.documentation = this.getDocumentation(funInfo);
					item.insertText = funInfo.Enumerator;
					item.sortText = `!2_${funName}`;
					this.globalSnippets.push(item);
				}
			}

			if (!existingMethods && methodItems.length > 0) {
				this.classMethodMap.set(shortName, methodItems);
			}
		}
	}

	getDocumentation(funInfo: JsFunction, shortName?: string) {
		let sigDisplay = funInfo.Signature || funInfo.Enumerator || '';
		// The $ class signature has no $. prefix; add it for readability
		if (shortName === '$' && funInfo.Function && !sigDisplay.startsWith('$.')) {
			sigDisplay = '$.' + sigDisplay;
		}
		let detail = '```js\n' + sigDisplay + '\n```';
		if (funInfo.Description) {
			detail += '\n\n' + funInfo.Description;
		}
		return new vscode.MarkdownString(detail);
	}

	/** Parse the parameter portion of the Signature and return the list of parameter names */
	private parseParams(signature: string): string[] {
		const parenStart = signature.indexOf('(');
		if (parenStart < 0) { return []; }
		const parenEnd = signature.lastIndexOf(')');
		const paramsStr = signature.substring(parenStart + 1, parenEnd).trim();
		if (!paramsStr) { return []; }
		return paramsStr.split(',').map(p => {
			const parts = p.trim().split(/\s+/);
			return parts.length > 1 ? parts[parts.length - 1] : parts[0];
		}).filter(p => p.length > 0);
	}

	/** dot context: insert only the method name + parameter tab stops (e.g. Time() or Msg(${1:...})) */
	private buildMethodSnippet(funInfo: JsFunction, isDollarClass: boolean = false): vscode.SnippetString {
		if (!funInfo.Signature) { return new vscode.SnippetString(''); }
		const sig = funInfo.Signature;
		// $ class signature format: "Msg( js_raw_args ... )" (no $. prefix) -> used directly as methodPart
		// Normal class format: "Game.Time()" (has a Class. prefix) -> take the part after the dot
		let methodPart: string;
		if (isDollarClass) {
			methodPart = sig;
		} else {
			const dotIdx = sig.indexOf('.');
			methodPart = dotIdx >= 0 ? sig.substring(dotIdx + 1) : sig;
		}
		const parenStart = methodPart.indexOf('(');
		if (parenStart < 0) { return new vscode.SnippetString(methodPart); }
		const methodName = methodPart.substring(0, parenStart).trim();
		const params = this.parseParams(sig);
		if (params.length === 0) {
			return new vscode.SnippetString(methodName + '()');
		}
		let text = methodName + '(';
		params.forEach((name, i) => {
			if (i > 0) { text += ', '; }
			text += '${' + (i + 1) + ':' + name + '}';
		});
		text += ')';
		return new vscode.SnippetString(text);
	}

	/** global context: insert Class.Method(params) (e.g. Game.Time(), $.Localize()) */
	private buildFullSnippet(funInfo: JsFunction, shortName: string, isDollarClass: boolean = false): vscode.SnippetString {
		if (!funInfo.Signature) { return new vscode.SnippetString(''); }
		const sig = funInfo.Signature;
		const parenStart = sig.indexOf('(');
		if (parenStart < 0) {
			return new vscode.SnippetString(isDollarClass ? '$.' + sig : sig);
		}
		// For the $ class: the signature is "Msg(...)" -> build "$.Msg(...)"
		// For normal classes: the signature already is "Game.Time(...)"
		const callName = isDollarClass
			? '$.' + sig.substring(0, parenStart).trim()
			: sig.substring(0, parenStart).trim();
		const params = this.parseParams(sig);
		if (params.length === 0) {
			return new vscode.SnippetString(callName + '()');
		}
		let text = callName + '(';
		params.forEach((name, i) => {
			if (i > 0) { text += ', '; }
			text += '${' + (i + 1) + ':' + name + '}';
		});
		text += ')';
		return new vscode.SnippetString(text);
	}

	provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem>> {
		const lineText = document.lineAt(position.line).text.substring(0, position.character);
		// Match "ClassName." or "$." ($ is not \w, so it needs special handling)
		const dotMatch = lineText.match(/([\w$]+)\.\s*$/);

		if (dotMatch) {
			const typedPrefix = dotMatch[1];
			// Case-insensitive lookup: game. -> Game, gameevents. -> GameEvents
			const normalizedName = this.classNameNormalize.get(typedPrefix.toLowerCase());
			if (normalizedName) {
				const methods = this.classMethodMap.get(normalizedName);
				if (methods) {
					// Если пользователь написал класс не в том регистре (game вместо Game),
					// нужно заменить введённый текст на правильный
					if (typedPrefix !== normalizedName) {
						const startPos = new vscode.Position(position.line, position.character - typedPrefix.length - 1);
						return methods.map(item => {
							const fixed = new vscode.CompletionItem(item.label, item.kind);
							fixed.detail = item.detail;
							fixed.documentation = item.documentation;
							fixed.sortText = item.sortText;
							// Заменяем "game." на "Game.Method()"
							fixed.insertText = this.prependClassSnippet(normalizedName, item.insertText as vscode.SnippetString);
							fixed.range = new vscode.Range(startPos, position);
							return fixed;
						});
					}
					return methods;
				}
			}
			// Не Dota 2 класс -> не мешаем
			return [];
		}

		return this.globalSnippets;
	}

	/** Создаёт snippet: "CorrectClassName.MethodSnippet" */
	private prependClassSnippet(className: string, methodSnippet: vscode.SnippetString): vscode.SnippetString {
		return new vscode.SnippetString(className + '.' + methodSnippet.value);
	}
}