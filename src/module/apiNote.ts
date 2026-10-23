import * as vscode from 'vscode';
import { DotaApiNote } from '../Class/DotaApiNote';
import { EventManager, EventType } from '../Class/event';
import { getCssCompletion, getJsCompletion, getLuaCompletion } from './completion';
import { readWithBundledFallback } from './dotaData';
import { showStatusBarMessage } from './statusBar';

let dotaApiNote: DotaApiNote;
let dotaDataEventID: number | undefined;

/** Instantiate the dota2 notes feature module */
export async function apiNoteInit(context: vscode.ExtensionContext) {
	dotaApiNote = readWithBundledFallback(() => new DotaApiNote(context));
	dotaApiNote.init(() => {
		console.log("[apiNoteInit]: Update lua code completion");
		let luaCompletion = getLuaCompletion();
		if (luaCompletion) {
			luaCompletion.refreshDocument();
		}
		console.log("[apiNoteInit]: Update css code completion");
		let cssCompletion = getCssCompletion();
		if (cssCompletion) {
			cssCompletion.refreshDocument();
		}
	});
	if (dotaDataEventID === undefined) {
		// New dumps downloaded (module/dotaData.ts): re-read the generated API files and rebuild the completions
		dotaDataEventID = EventManager.listenToEvent(EventType.EVENT_ON_DOTA_DATA_UPDATED, () => {
			try {
				readWithBundledFallback(() => {
					dotaApiNote?.reload();
					getLuaCompletion()?.refreshDocument();
					getCssCompletion()?.refreshDocument();
					getJsCompletion()?.refreshDocument();
				});
			} catch (error) {
				showStatusBarMessage(`[apiNoteInit]: ${error instanceof Error ? error.message : error}`);
			}
		});
	}
}

export function getDotaApiNoteClass() {
	return dotaApiNote;
}