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

/** 优先类排序 —— 越靠前越高优先级 */
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
	/** 全局补全列表 (类名 + 函数 + 枚举) —— 非 dot 上下文 */
	globalSnippets: vscode.CompletionItem[];
	/** 按短类名分组的方法补全 (如 "Game" -> [Time, GetGameTime, ...]) —— dot 上下文 */
	classMethodMap: Map<string, vscode.CompletionItem[]>;
	/** 短类名小写 -> 正确大小写映射 (game -> Game, gameevents -> GameEvents) */
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
		/** 去重: 全局上下文函数名 -> 已添加 */
		const globalFunctionAdded = new Set<string>();

		for (const className in this.document) {
			const classData = this.document[className];
			// 从第一个函数签名中提取简短类名 (如 "GameEvents.Subscribe(...)" -> "GameEvents")
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

			// 类名补全 (如 $, Game, GameEvents, Particles)
			if (!classShortNames.has(shortName)) {
				classShortNames.add(shortName);
				this.classNameNormalize.set(shortName.toLowerCase(), shortName);
				let classItem = new vscode.CompletionItem(shortName, vscode.CompletionItemKind.Class);
				classItem.detail = `${DOTA_LABEL} — ${className}`;
				classItem.sortText = `!0_${classPriority}_${shortName}`;
				this.globalSnippets.push(classItem);
			}

			/** 去重: dot 上下文方法名 -> 已添加 (在同一shortName内) */
			const existingMethods = this.classMethodMap.get(shortName);
			const dotMethodAdded = new Set<string>();
			if (existingMethods) {
				existingMethods.forEach(item => dotMethodAdded.add(item.label as string));
			}

			const methodItems: vscode.CompletionItem[] = existingMethods || [];

			for (const funName in classData) {
				let funInfo = classData[funName];
				if (funInfo.Function) {
					// ===== dot 上下文 (Game. -> Time) : 去重同一 shortName 内 =====
					if (!dotMethodAdded.has(funName)) {
						dotMethodAdded.add(funName);
						let dotItem = new vscode.CompletionItem(funName, vscode.CompletionItemKind.Method);
						dotItem.detail = `${DOTA_LABEL} — ${funInfo.Description || ''}`;
						dotItem.documentation = this.getDocumentation(funInfo, shortName);
						dotItem.insertText = this.buildMethodSnippet(funInfo, isDollarClass);
						dotItem.sortText = `0_${funName}`;
						methodItems.push(dotItem);
					}

					// ===== 全局上下文 (time -> Game.Time()) : 只保留一个 =====
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
		// $ 类的签名没有 $. 前缀，补上方便显示
		if (shortName === '$' && funInfo.Function && !sigDisplay.startsWith('$.')) {
			sigDisplay = '$.' + sigDisplay;
		}
		let detail = '```js\n' + sigDisplay + '\n```';
		if (funInfo.Description) {
			detail += '\n\n' + funInfo.Description;
		}
		return new vscode.MarkdownString(detail);
	}

	/** 解析 Signature 的参数部分，返回参数名列表 */
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

	/** dot 上下文: 只插入方法名 + 参数 tab stops (如 Time() 或 Msg(${1:...})) */
	private buildMethodSnippet(funInfo: JsFunction, isDollarClass: boolean = false): vscode.SnippetString {
		if (!funInfo.Signature) { return new vscode.SnippetString(''); }
		const sig = funInfo.Signature;
		// $ 类签名格式: "Msg( js_raw_args ... )" (无 $. 前缀) -> 直接用作methodPart
		// 普通类格式: "Game.Time()" (有 Class. 前缀) -> 取 dot 后部分
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

	/** 全局上下文: 插入 Class.Method(params) (如 Game.Time(), $.Localize()) */
	private buildFullSnippet(funInfo: JsFunction, shortName: string, isDollarClass: boolean = false): vscode.SnippetString {
		if (!funInfo.Signature) { return new vscode.SnippetString(''); }
		const sig = funInfo.Signature;
		const parenStart = sig.indexOf('(');
		if (parenStart < 0) {
			return new vscode.SnippetString(isDollarClass ? '$.' + sig : sig);
		}
		// 对于 $ 类: 签名是 "Msg(...)" → 构建 "$.Msg(...)"
		// 对于普通类: 签名已有 "Game.Time(...)"
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
		// 匹配 "ClassName." 或 "$." ($ 不是 \w，需要特殊处理)
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