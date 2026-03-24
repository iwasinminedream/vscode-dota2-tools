import * as fs from 'fs';
import * as os from 'os';
import * as vscode from 'vscode';
import { getGameDir, isValidFolder } from '../module/addonInfo';
import { StatusBarState, changeStatusBarState, refreshStatusBarMessage, showStatusBarMessage } from '../module/statusBar';
import { getPathConfiguration } from '../utils/getPathConfiguration';
import { readKeyValue2 } from '../utils/kvUtils';
import { localize } from '../utils/localize';

export async function combineLocalization(languageType: string = "") {
	if (isValidFolder() === false) {
		return;
	}
	// 消息
	changeStatusBarState(StatusBarState.LOADING);
	let messageIndex = showStatusBarMessage(localize('msg_merge_text', [languageType == "" ? "ALL" : languageType]));
	const gameDir = getGameDir();
	const localizationPath = getPathConfiguration("dota2-tools.A5.localization_path");
	if (localizationPath) {
		if (languageType !== "") {
			let language = await getLanguageContent(localizationPath, languageType);
			if (language != undefined) {
				fs.writeFileSync(gameDir + '/resource/addon_' + languageType + '.txt', language);
				refreshStatusBarMessage(messageIndex, localize('msg_merge_text', [localizationPath + '/' + languageType]));
			}
		} else {
			let langFolders: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(localizationPath));
			// langFolders按folderName排序
			langFolders.sort((a, b) => a[0].localeCompare(b[0]));
			for (let i: number = 0; i < langFolders.length; i++) {
				const [folderName, isDirectory] = langFolders[i];
				if (Number(isDirectory) === vscode.FileType.Directory) {
					let language = await getLanguageContent(localizationPath, folderName);
					if (language != undefined) {
						fs.writeFileSync(gameDir + '/resource/addon_' + folderName + '.txt', language);
						refreshStatusBarMessage(messageIndex, localize('msg_merge_text', [localizationPath + '/' + folderName]));
					}
					// let text_editor: vscode.TextEditor = await vscode.window.showTextDocument(vscode.Uri.file(root_path + '/game/dota_addons/dota_imba/resource/addon_' + folder_name + '.txt'));
					// text_editor.edit(function (edit_builder) {
					// 	edit_builder.delete(new vscode.Range(new vscode.Position(0,0),text_editor.document.lineAt(text_editor.document.lineCount - 1).range.end));
					// 	edit_builder.insert(new vscode.Position(0,0),language);
					// });
				}
			}
			refreshStatusBarMessage(messageIndex, localize('msg_merge_text_done'));
		}
		changeStatusBarState(StatusBarState.ALL_DONE);
	}
}
async function getLanguageContent(localizationPath: string, languageType: string) {
	if (languageType == "history") {
		return;
	}
	const languagePath: string = localizationPath + '/' + languageType;
	let language: string = `"lang"
{
	"Language"		"` + languageType.charAt(0).toUpperCase() + languageType.slice(1) + `"
	"Tokens"
	{
`;
	let promise: string = await readLanguage(languagePath);
	language += promise;
	language += `
	}
}`;
	return language;
}

async function readLanguage(path: string): Promise<string> {
	let lang: string = '';
	let files: [string, vscode.FileType][] = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
	files.sort((a, b) => a[0].localeCompare(b[0]));
	for (let i = 0; i < files.length; i++) {
		const [fileName, fileType] = files[i];
		if (Number(fileType) === vscode.FileType.File) {
			try {
				let document: vscode.TextDocument = await vscode.workspace.openTextDocument(path + '/' + fileName);
				const langContent = document.getText();

				// 使用 KV 解析器提取 Tokens 内容，更健壮地处理各种格式
				const parsed = readKeyValue2(langContent);

				// 尝试多种结构：
				// 1. 标准结构：lang.Tokens
				// 2. 旧版本：直接就是 tokens（没有外层包裹）
				let tokens: Record<string, unknown> | undefined;

				const langBlock = parsed?.lang;
				if (langBlock && typeof langBlock === 'object') {
					tokens = (langBlock as Record<string, unknown>).Tokens as Record<string, unknown> | undefined;
				}

				// 如果没有找到 lang.Tokens，检查是否直接就是 tokens（旧版本格式）
				if (!tokens && parsed && typeof parsed === 'object') {
					// 如果 parsed 包含的都是字符串值，说明这是旧版本的直接 token 格式
					const entries = Object.entries(parsed as Record<string, unknown>);
					const hasStringValues = entries.length > 0 && entries.some(([_, value]) => typeof value === 'string');
					if (hasStringValues) {
						tokens = parsed as Record<string, unknown>;
					}
				}

				if (tokens && typeof tokens === 'object') {
					// 添加文件路径注释
					lang += "\t\t//" + path.split("localization/")[1] + '/' + fileName + os.EOL;

					// 手动生成 Tokens 内容，确保格式正确
					for (const [key, value] of Object.entries(tokens)) {
						if (typeof value === 'string') {
							// 转义引号并格式化
							const escapedValue = value.replace(/"/g, '\\"');
							lang += `\t\t"${key}"\t\t"${escapedValue}"${os.EOL}`;
						}
					}
					lang += os.EOL;
				} else {
					// 如果解析失败，使用改进的正则表达式作为后备方案
					// 支持首尾的注释、空行和空白字符
					const modifiedContent = extractTokensContent(langContent);
					if (modifiedContent) {
						lang += "\t\t//" + path.split("localization/")[1] + '/' + fileName + os.EOL;
						lang += modifiedContent + os.EOL;
						lang += os.EOL;
					}
				}
			} catch (error) {
				console.error(`Failed to process file ${path}/${fileName}:`, error);
			}
		} else if (Number(fileType) === vscode.FileType.Directory) {
			let promise: string = await readLanguage(path + '/' + fileName);
			lang += promise;
		}
	}
	return Promise.resolve(lang);
}

/**
 * 提取 VDF 文件中的 Tokens 内容（后备方案）
 * 使用改进的正则表达式，支持注释、空行等
 */
function extractTokensContent(content: string): string {
	// 移除首尾的空白字符和注释
	const trimmed = content.trim();

	// 尝试匹配 "lang" { ... "Tokens" { ... } }
	// 使用 [\s\S] 匹配包括换行符在内的所有字符
	const tokensMatch = trimmed.match(/"lang"[\s\S]*?"Tokens"[\s\S]*?\{([\s\S]*)\}[\s\S]*?\}[\s\S]*$/);

	if (tokensMatch && tokensMatch[1]) {
		// 提取 Tokens 块内容
		let tokensContent = tokensMatch[1];

		// 清理内容：移除首尾空白，但保留中间的格式
		const lines = tokensContent.split(/\r?\n/);
		const filteredLines = lines
			.map(line => line.trim())
			.filter(line => line.length > 0 && !line.startsWith('//'));

		return filteredLines.join(os.EOL);
	}

	return '';
}