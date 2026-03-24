import * as vscode from 'vscode';
import * as fs from 'fs';
import { getWebviewContent } from '../utils/getWebViewContent';
import { readFile } from '../utils/readFile';
import { readKeyValue2 } from '../utils/kvUtils';
import { hasLocalize, hasReverseLocalize, localize, reverseLocalize } from '../utils/localize';
import { isNumber } from '../utils/isNumber';
import { TextEncoder } from 'util';
import { getExtensionLang } from '../utils/getExtensionLang';
import path = require('path');

let itemsGame: Table;
let language: Table;

enum LangEnum {
	schinese = "zh-cn",
	english = "en"
};

/** 获取用户配置的饰品查询语言 */
function getItemsGameLang(): "zh-cn" | "en" {
	return getExtensionLang();
}

export async function dota2ItemsGameInit(context: vscode.ExtensionContext) {
	itemsGame = JSON.parse(await readFile(vscode.Uri.joinPath(context.extensionUri, "resource/items_game.json")));
	language = {
		[LangEnum.schinese]: readKeyValue2(await readFile(vscode.Uri.joinPath(context.extensionUri, "resource/items_schinese.txt")), false).lang.Tokens,
		[LangEnum.english]: readKeyValue2(await readFile(vscode.Uri.joinPath(context.extensionUri, "resource/items_english.txt")), false).lang.Tokens
	};
}

/** 尝试获取物品图标的 base64 编码 */
function getItemIconBase64(imageInventory: string | undefined, context: vscode.ExtensionContext): string | undefined {
	if (!imageInventory) {
		return undefined;
	}
	// 优先从用户配置的 econ_path 读取
	let econPath: string | undefined = vscode.workspace.getConfiguration().get("dota2-tools.A5.econ_path");
	if (econPath != undefined && econPath !== "") {
		try {
			const image = fs.readFileSync(path.join(econPath, imageInventory + "_png.png"));
			return Buffer.from(image).toString('base64');
		} catch (error) { }
	}
	// 其次从扩展内置图标读取
	try {
		const bundledPath = path.join(context.extensionPath, "images", "econ_items", imageInventory + "_png.png");
		const image = fs.readFileSync(bundledPath);
		return Buffer.from(image).toString('base64');
	} catch (error) { }
	return undefined;
}

/**
 * item_game.txt里的饰品查询
 * @export
 * @param {vscode.ExtensionContext} context
 */
export async function dota2ItemsGame(context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'dota2ItemsGame', // viewType
		localize("dota2tools.items_game"), // 视图标题
		vscode.ViewColumn.One, // 显示在编辑器的哪个部位
		{
			enableScripts: true, // 启用JS，默认禁用
			retainContextWhenHidden: true, // webview被隐藏时保持状态，避免被重置
		}
	);
	panel.webview.html = await getWebviewContent(panel.webview, context.extensionUri, 'dota2ItemsGame');

	// 发送当前配置的语言到webview
	const uiLang = getItemsGameLang();
	panel.webview.postMessage({ type: "set_language", data: uiLang });

	// 监听语言配置变化，实时更新webview语言
	const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('dota2-tools.language')) {
			panel.webview.postMessage({ type: "set_language", data: getItemsGameLang() });
		}
	});
	panel.onDidDispose(() => configListener.dispose());

	// 监听消息
	panel.webview.onDidReceiveMessage(async (message: { type: string, text: string, language: string; }) => {
		const type = message.type;
		const text = message.text;
		// 加载资源
		if (itemsGame === undefined) {
			await dota2ItemsGameInit(context);
		}

		switch (type) {
			case "query_item_data":	// 获取物品数据（搜索）
			{
				let inputResult = validInput(text, context);
				if (typeof (inputResult) === "string") {
					panel.webview.postMessage({
						type: "query_item_data",
						data: getItemInfo(inputResult, context),
					});
				} else if (typeof (inputResult) === "object") {
					panel.webview.postMessage({
						type: "query_item_list_data",
						data: inputResult,
					});
				}
				return;
			}
			case "query_item_by_id": // 通过ID直接查询物品（从列表点击或导航跳转）
			{
				if (text && itemsGame[text]) {
					panel.webview.postMessage({
						type: "query_item_data",
						data: getItemInfo(text, context),
					});
				}
				return;
			}
		}
	}, null, context.subscriptions);
}

/** 验证输入的内容是否有效 */
function validInput(text: string, context: vscode.ExtensionContext) {
	const lang = getItemsGameLang();

	// 精确 ID 搜索
	if (isNumber(text)) {
		if (itemsGame[text]) {
			return text;
		}
	}

	// 模型路径搜索
	if (/models.*.vmdl/.test(text)) {
		let index = getIndexByModelName(text) || getIndexByAssetModifierName(text);
		if (index) {
			return index;
		}
	}

	// 粒子特效路径搜索
	if (/particles.*.vpcf/.test(text)) {
		let index = getIndexByAssetModifierName(text);
		if (index) {
			return index;
		}
	}

	// 图标路径搜索 (econ/)
	if (/econ\//.test(text)) {
		let index = getIndexByImageInventory(text);
		if (index) {
			return index;
		}
	}

	// 英雄名搜索 (npc_dota_hero_xxx)
	if ((/npc_dota_hero_/.test(text) && (hasLocalize(text)) || hasLocalize("npc_dota_hero_" + text))) {
		return buildHeroItemList(findItemsByHeroName(text), lang, context);
	}

	// 反向本地化搜索 (中文/英文英雄名 -> npc_dota_hero_xxx)
	if (hasReverseLocalize(text)) {
		return buildHeroItemList(findItemsByHeroName(reverseLocalize(text)), lang, context);
	}

	// 按物品名称搜索 (name 字段，模糊匹配)
	let nameResults = findItemsByItemName(text);
	if (Object.keys(nameResults).length > 0) {
		return buildHeroItemList(nameResults, lang, context);
	}

	// 按翻译后的物品名搜索 (item_name 翻译值)
	let translatedResults = findItemsByTranslatedName(text, lang);
	if (Object.keys(translatedResults).length > 0) {
		return buildHeroItemList(translatedResults, lang, context);
	}

	// 按粒子/模型/资源搜索 (模糊)
	let assetResults = findItemsByAssetModifier(text);
	if (Object.keys(assetResults).length > 0) {
		return buildHeroItemList(assetResults, lang, context);
	}

	// 组合搜索：英雄名 + 物品关键词 (如 "crystal maiden weapon")
	let combinedResult = tryCombinedHeroItemSearch(text, lang, context);
	if (combinedResult) {
		return combinedResult;
	}

	return false;
}

/**
 * 尝试将输入文本拆分为 (heroQuery, itemQuery) 的所有可能组合。
 * 对于每种拆分，检查 heroQuery 是否对应某个英雄，然后按 itemQuery 过滤物品。
 */
function tryCombinedHeroItemSearch(text: string, lang: "zh-cn" | "en", context: vscode.ExtensionContext): string[][] | false {
	const words = text.trim().split(/\s+/);
	if (words.length < 2) {
		return false;
	}

	const languageInfo = language[lang];

	// 尝试每个拆分点：words[0..i] = 英雄部分, words[i+1..] = 物品部分
	for (let i = 0; i < words.length - 1; i++) {
		const heroPart = words.slice(0, i + 1).join(" ");
		const itemPart = words.slice(i + 1).join(" ").toLowerCase();

		let heroKey: string | undefined;

		// 检查 heroPart 是否是已知英雄名 (npc_dota_hero_xxx)
		if (hasLocalize(heroPart)) {
			heroKey = heroPart;
		} else if (hasLocalize("npc_dota_hero_" + heroPart.replace(/\s+/g, "_"))) {
			heroKey = "npc_dota_hero_" + heroPart.replace(/\s+/g, "_");
		} else if (hasReverseLocalize(heroPart)) {
			heroKey = reverseLocalize(heroPart);
		}

		if (!heroKey) {
			continue;
		}

		// 找到英雄 - 获取该英雄所有物品，按 itemPart 过滤
		const heroItems = findItemsByHeroName(heroKey);
		if (Object.keys(heroItems).length === 0) {
			continue;
		}

		// 按物品关键词过滤英雄物品
		const filtered: Table = {};
		for (const index in heroItems) {
			const itemData = heroItems[index];
			const translatedName = itemData.item_name
				? (languageInfo[itemData.item_name.replace("#", "")] || "").toLowerCase()
				: "";
			const internalName = (itemData.name || "").toLowerCase();

			if (translatedName.indexOf(itemPart) !== -1 || internalName.indexOf(itemPart) !== -1) {
				filtered[index] = itemData;
			}
		}

		if (Object.keys(filtered).length > 0) {
			return buildHeroItemList(filtered, lang, context);
		}
	}

	return false;
}

/** 构建英雄物品列表（搜索结果列表） */
function buildHeroItemList(items: Table, lang: "zh-cn" | "en", context: vscode.ExtensionContext): string[][] {
	let languageInfo = language[lang];
	let result: string[][] = [[localize("icon", undefined, lang), localize("index", undefined, lang), localize("item_name", undefined, lang), localize("item_slot", undefined, lang), localize("prefab", undefined, lang), localize("model_player", undefined, lang)]];
	let rows: string[][] = [];
	for (const index in items) {
		const itemData = items[index];
		const iconBase64 = getItemIconBase64(itemData.image_inventory, context);
		const iconCell = iconBase64 ? `<img src="data:image/png;base64,${iconBase64}" class="list-icon" />` : "";
		const itemSlotKey = itemData.item_slot ? `loadoutslot_${itemData.item_slot}`.toLowerCase() : "";
		rows.push([
			iconCell,
			index,
			languageInfo[itemData.item_name?.replace("#", "")] || itemData.name || "",
			itemSlotKey ? (localize(itemSlotKey, undefined, lang) || itemData.item_slot || "") : "",
			localize(itemData.prefab, undefined, lang) || "",
			itemData.model_player || ""
		]);
	}
	// 按装备栏位排序，然后按 prefab 排序，最后按 index 排序
	rows.sort((a, b) => {
		const slotCmp = (a[3] || "").localeCompare(b[3] || "");
		if (slotCmp !== 0) { return slotCmp; }
		const prefabCmp = (a[4] || "").localeCompare(b[4] || "");
		if (prefabCmp !== 0) { return prefabCmp; }
		return parseInt(a[1]) - parseInt(b[1]);
	});
	result.push(...rows);
	return result;
}

function getItemInfo(index: string, context: vscode.ExtensionContext) {
	let result: Table = {};
	let itemInfo: Table = itemsGame[index];
	const lang = getItemsGameLang();

	// 物品图标
	const iconBase64 = getItemIconBase64(itemInfo.image_inventory, context);
	if (iconBase64) {
		result.econImg = iconBase64;
	}

	let languageInfo = language[lang];
	result[localize("index", undefined, lang)] = index;
	if (itemInfo.name) {
		result[localize("internal_name", undefined, lang)] = itemInfo.name;
	}
	if (itemInfo.item_name) {
		result[localize("item_name", undefined, lang)] = languageInfo[itemInfo.item_name.replace("#", "")];
	}
	if (itemInfo.item_description) {
		result[localize("item_description", undefined, lang)] = languageInfo[itemInfo.item_description.replace("#", "")];
	}
	if (itemInfo.used_by_heroes) {
		result[localize("used_by_heroes", undefined, lang)] = localize(Object.keys(itemInfo.used_by_heroes)[0], undefined, lang);
	}
	if (itemInfo.prefab) {
		result[localize("prefab", undefined, lang)] = localize(itemInfo.prefab, undefined, lang);
	}
	if (itemInfo.item_type_name) {
		result[localize("item_type_name", undefined, lang)] = languageInfo[itemInfo.item_type_name];
	}
	if (itemInfo.item_slot) {
		result[localize("item_slot", undefined, lang)] = localize(`LoadoutSlot_${itemInfo.item_slot}`.toLowerCase(), undefined, lang);
	}
	if (itemInfo.model_player) {
		result[localize("model_player", undefined, lang)] = itemInfo.model_player;
	}
	if (itemInfo.image_inventory) {
		result[localize("image_inventory", undefined, lang)] = itemInfo.image_inventory;
	}
	if (itemInfo.bundle) {
		let bundle: Table = {};
		for (const itemName in itemInfo.bundle) {
			let itemIndex = getIndexByName(itemName);
			let item = getItemByName(itemName);

			if (itemIndex && item) {
				const bundleIconBase64 = getItemIconBase64(item.image_inventory, context);
				bundle[itemIndex] = {
					name: languageInfo[item.item_name?.replace("#", "")] || itemName,
					icon: bundleIconBase64 || ""
				};
			}
		}

		bundle["localize"] = localize("bundle", undefined, lang);
		result["bundle"] = bundle;
	}
	let bundleContain = getBundlesByName(itemInfo.name);
	if (Object.keys(bundleContain).length > 0) {
		let bundle: Table = {};
		for (const itemIndex in bundleContain) {
			const bundleIconBase64 = getItemIconBase64(bundleContain[itemIndex].image_inventory, context);
			bundle[itemIndex] = {
				name: languageInfo[bundleContain[itemIndex].item_name?.replace("#", "")] || "",
				icon: bundleIconBase64 || ""
			};
		}
		bundle["localize"] = localize("bundle_contain", undefined, lang);
		result["bundle_contain"] = bundle;
	}
	if (itemInfo.visuals) {
		let visuals: Table[] = [];
		for (const key in itemInfo.visuals) {
			if (key.match(/asset_modifier/) !== null) {
				const assetModifier = itemInfo.visuals[key];
				let row: Table = { _key: key };
				for (const name in assetModifier) {
					row[name] = assetModifier[name];
				}
				visuals.push(row);
			}
		}
		result["visuals"] = {
			localize: localize("visuals", undefined, lang),
			rows: visuals
		};
	}
	if (itemInfo.price_info) {
		let priceInfo: Table = {};
		for (const key in itemInfo.price_info) {
			priceInfo[key] = itemInfo.price_info[key];
		}
		priceInfo["localize"] = localize("price_info", undefined, lang);
		result["price_info"] = priceInfo;
	}
	return result;
}

// 根据 image_inventory 索引物品
function getIndexByImageInventory(sImageInventory: string) {
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.image_inventory === sImageInventory) {
			return index;
		}
	}
	return undefined;
}

// 根据物品名称模糊搜索 (name 字段)
function findItemsByItemName(text: string): Table {
	let itemList: Table = {};
	const lowerText = text.toLowerCase();
	let count = 0;
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.name && itemData.name.toLowerCase().indexOf(lowerText) !== -1) {
			itemList[index] = itemData;
			count++;
			if (count >= 200) { break; }
		}
	}
	return itemList;
}

// 根据翻译后的物品名搜索
function findItemsByTranslatedName(text: string, lang: "zh-cn" | "en"): Table {
	let itemList: Table = {};
	const lowerText = text.toLowerCase();
	const languageInfo = language[lang];
	let count = 0;
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.item_name) {
			const translatedName = languageInfo[itemData.item_name.replace("#", "")];
			if (translatedName && translatedName.toLowerCase().indexOf(lowerText) !== -1) {
				itemList[index] = itemData;
				count++;
				if (count >= 200) { break; }
			}
		}
	}
	return itemList;
}

// 根据 asset modifier 模糊搜索 (粒子/模型/资源路径)
function findItemsByAssetModifier(text: string): Table {
	let itemList: Table = {};
	const lowerText = text.toLowerCase();
	let count = 0;
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.visuals) {
			for (const modifierIndex in itemData.visuals) {
				const mod = itemData.visuals[modifierIndex];
				if (typeof mod === "object") {
					const modifier = mod.modifier || mod.asset || "";
					if (modifier.toLowerCase().indexOf(lowerText) !== -1) {
						itemList[index] = itemData;
						count++;
						break;
					}
				}
			}
		}
		if (count >= 200) { break; }
	}
	return itemList;
}

// 根据资源modifier索引物品
function getIndexByAssetModifierName(sModifierName: string) {
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.visuals) {
			for (const modifierIndex in itemData.visuals) {
				if (itemData.visuals[modifierIndex].modifier === sModifierName) {
					return index;
				}
			}
		}
	}
	return undefined;
}

// 根据模型名字索引编号
function getIndexByModelName(sModelName: string) {
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.model_player === sModelName) {
			return index;
		}
	}
	return undefined;
}
// 根据名字索引编号
function getIndexByName(sName: string) {
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.name === sName) {
			return index;
		}
	}
	return undefined;
}
// 根据名字索引物品
function getItemByName(sName: string) {
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.name === sName) {
			return itemData;
		}
	}
	return undefined;
}
// 根据名字索引捆绑包信息
function getBundlesByName(sName: string) {
	let bundles: Table = {};
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.bundle !== undefined) {
			for (const bundleItemName in itemData.bundle) {
				if (bundleItemName === sName) {
					bundles[index] = itemData;
				}
			}
		}
	}
	return bundles;
}
function findItemsByHeroName(sHeroName: string) {
	let itemList: Table = {};
	for (const index in itemsGame) {
		const itemData = itemsGame[index];
		if (itemData.used_by_heroes !== undefined) {
			for (const heroName in itemData.used_by_heroes) {
				if (heroName === sHeroName || heroName.search(new RegExp(sHeroName, 'i')) !== -1) {
					itemList[index] = itemData;
				}
			}
		}
	}
	return itemList;
}