import * as vscode from 'vscode';
import { getKeyValueObjectByIndex, readKeyValueWithBase } from '../utils/kvUtils';
import { localize } from '../utils/localize';
import { getResourcePath } from '../utils/releaseData';

/** 复制dota2官方物品删除列表到剪切板 */
export async function getItemRemoveList(context: vscode.ExtensionContext) {
	let kv = getKeyValueObjectByIndex(await readKeyValueWithBase(getResourcePath(context, 'resource', 'npc', 'items.txt')));
	let str = "";
	for (const name in kv) {
		if (typeof (kv[name]) !== "object") { continue; }
		str += `\t"${name}"
	{
		"ItemPurchasable"				"0"
	}
`;
	}

	vscode.env.clipboard.writeText(str);
	vscode.window.showInformationMessage(localize('msg_item_remove_list'));
}