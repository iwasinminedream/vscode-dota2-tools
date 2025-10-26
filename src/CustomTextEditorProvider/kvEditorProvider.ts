import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getContentDir, getGameDir } from '../module/addonInfo';
import { findKvEntryForUri, KvEditorEntry, KvFolderType, readKvEditorSettings } from '../module/kvEditorConfig';
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
		this.extensionImagesRoot = this.context.asAbsolutePath('images');
		this.columnOptionConfig = this.readColumnOptionConfig();
	}

	private readonly extensionImagesRoot: string;
	private readonly columnOptionConfig: KvEditorColumnOptionMap;
	private readonly textureMenuCache = new Map<string, TextureMenuRawIcon[]>();
	private readonly localizationCache = new Map<string, LocalizationCacheEntry>();
	private readonly userSettingsCache = new Map<string, KvEditorUserSettings>();
	private heroFilterCache: TextureMenuHeroCache[] | undefined;

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
			postPayload(this.buildPayload(document, webviewPanel.webview));
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
			if (message.type === 'editAbilityValues') {
				const abilityEditMessage: KvEditorAbilityValuesEditMessage | undefined = message.payload;
				this.handleAbilityValuesEditMessage(document, abilityEditMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
				return;
			}
			if (message.type === 'bulkEdit') {
				const bulkMessage: KvEditorBulkEditMessage | undefined = message.payload;
				this.handleBulkEditMessage(document, bulkMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
				return;
			}
			if (message.type === 'edit') {
				const editMessage: KvEditorEditMessage | undefined = message.payload;
				this.handleEditMessage(document, editMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
			}
			if (message.type === 'reorderRows') {
				const reorderMessage: KvEditorReorderMessage | undefined = message.payload;
				this.handleReorderRows(document, reorderMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
			}
			if (message.type === 'reorderColumns') {
				const reorderMessage: KvEditorColumnReorderMessage | undefined = message.payload;
				this.handleReorderColumns(document, reorderMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
			}
			if (message.type === 'saveColumnWidths') {
				const saveMessage: KvEditorSaveColumnWidthsMessage | undefined = message.payload;
				this.handleSaveColumnWidths(document, saveMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
				return;
			}
			if (message.type === 'requestTextureMenu') {
				const requestPayload: TextureMenuRequestMessage | undefined = message.payload;
				if (!requestPayload || typeof requestPayload.requestId !== 'string') {
					return;
				}
				void this.handleTextureMenuRequest(document, webviewPanel.webview, requestPayload);
				return;
			}
			if (message.type === 'openScriptFile') {
				const requestPayload: OpenScriptFileMessage | undefined = message.payload;
				void this.handleOpenScriptFile(document, requestPayload);
			}
		});

		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
			messageListener.dispose();
		});

		updateWebview();
	}

	private buildPayload(document: vscode.TextDocument, webview: vscode.Webview): KvEditorPayload {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		const documentKey = workspaceFolder ? this.getDocumentSettingsKey(document.uri, workspaceFolder) : undefined;
		const settings = readKvEditorSettings();
		const entry = settings ? findKvEntryForUri(document.uri, settings) : undefined;
		const folderType: KvFolderType = entry?.type ?? 'custom';
		const parsed = this.parseKv(document.getText());
		this.enrichRowsWithLocalization(parsed.rows, folderType, document.uri.fsPath, entry);
		const columnLayout = this.loadColumnLayout(document);
		return {
			fileName: path.basename(document.uri.fsPath),
			documentKey,
			folderType,
			header: parsed.header,
			columns: parsed.columns,
			rows: parsed.rows,
			error: parsed.error,
			columnOptions: this.getResolvedColumnOptions(folderType),
			columnLayout,
			texturePreviews: this.buildTexturePreviews(document, parsed.rows, webview, entry),
			scriptSupport: this.buildScriptSupport(folderType),
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
				const columnConfig = this.parseColumnOptionSource(value);
				if (!columnConfig) {
					continue;
				}
				result[column] = columnConfig;
			}
			return result;
		} catch (error) {
			console.warn('[kvEditorProvider] Failed to read column option config:', error);
			return {};
		}
	}

	private parseColumnOptionSource(raw: unknown): KvEditorColumnOptionSource | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const obj = raw as Record<string, unknown>;
		const options = this.parseOptionEntries(obj.options);
		if (!options.length) {
			return undefined;
		}
		const multiple = Boolean(obj.multiple);
		const separatorRaw = obj.separator;
		const separator = typeof separatorRaw === 'string' && separatorRaw.length > 0 ? separatorRaw : ',';
		const overridesRaw = obj.overrides;
		let overrides: Partial<Record<KvFolderType, KvEditorColumnOptionOverride>> | undefined;
		if (overridesRaw && typeof overridesRaw === 'object' && !Array.isArray(overridesRaw)) {
			overrides = {};
			for (const [key, overrideValue] of Object.entries(overridesRaw as Record<string, unknown>)) {
				const folderType = this.normalizeFolderTypeKey(key);
				if (!folderType) {
					continue;
				}
				const parsedOverride = this.parseOverrideConfig(overrideValue);
				if (!parsedOverride) {
					continue;
				}
				overrides[folderType] = parsedOverride;
			}
			if (!Object.keys(overrides).length) {
				overrides = undefined;
			}
		}
		return { options, multiple, separator, overrides };
	}

	private parseOptionEntries(raw: unknown): KvEditorColumnOption[] {
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw
			.map((entry) => {
				if (!entry || typeof entry !== 'object') {
					return undefined;
				}
				const optionObj = entry as Record<string, unknown>;
				const value = optionObj.value;
				if (typeof value !== 'string') {
					return undefined;
				}
				const rawLabel = optionObj.label;
				const rawDescription = optionObj.description;
				const option: KvEditorColumnOption = {
					value,
					label: typeof rawLabel === 'string' && rawLabel.length > 0 ? rawLabel : value,
				};
				if (typeof rawDescription === 'string' && rawDescription.length > 0) {
					option.description = rawDescription;
				}
				return option;
			})
			.filter((entry): entry is KvEditorColumnOption => Boolean(entry));
	}

	private parseOverrideConfig(raw: unknown): KvEditorColumnOptionOverride | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const obj = raw as Record<string, unknown>;
		const override: KvEditorColumnOptionOverride = {};
		const options = this.parseOptionEntries(obj.options);
		if (options.length) {
			override.options = options;
		}
		if (typeof obj.multiple === 'boolean') {
			override.multiple = obj.multiple;
		}
		const separatorRaw = obj.separator;
		if (typeof separatorRaw === 'string' && separatorRaw.length > 0) {
			override.separator = separatorRaw;
		}
		if (!override.options && override.multiple === undefined && override.separator === undefined) {
			return undefined;
		}
		return override;
	}

	private normalizeFolderTypeKey(input: string): KvFolderType | undefined {
		switch (input) {
			case 'ability':
			case 'item':
			case 'unit':
			case 'custom':
				return input;
			default:
				return undefined;
		}
	}

	private getResolvedColumnOptions(folderType: KvFolderType): KvEditorColumnOptionResolvedMap {
		const resolved: KvEditorColumnOptionResolvedMap = {};
		for (const [column, config] of Object.entries(this.columnOptionConfig)) {
			const override = config.overrides?.[folderType];
			const options = override?.options ?? config.options;
			const multiple = override?.multiple ?? config.multiple;
			const separator = override?.separator ?? config.separator;
			resolved[column] = { options, multiple, separator };
		}
		return resolved;
	}

	private buildScriptSupport(folderType: KvFolderType): KvEditorScriptSupport {
		const useTypescript = Boolean(vscode.workspace.getConfiguration().get('dota2-tools.A6.Kv to lua generate typescript'));
		const baseDir = useTypescript ? getContentDir() : getGameDir();
		const applicable = folderType === 'ability' || folderType === 'item';
		return {
			applicable,
			baseReady: applicable ? Boolean(baseDir) : false,
			useTypescript,
		};
	}

	private async handleTextureMenuRequest(
		document: vscode.TextDocument,
		webview: vscode.Webview,
		request: TextureMenuRequestMessage,
	): Promise<void> {
		try {
			const settings = readKvEditorSettings();
			const entry = settings ? findKvEntryForUri(document.uri, settings) : undefined;
			const folderType = request.folderType ?? this.detectFolderType(document.uri);
			const response = await this.buildTextureMenuResponse(webview, folderType, entry, document.uri.fsPath);
			webview.postMessage({
				type: 'textureMenuData',
				payload: {
					requestId: request.requestId,
					...response,
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			webview.postMessage({
				type: 'textureMenuError',
				payload: {
					requestId: request.requestId,
					error: message,
				},
			});
		}
	}

	private detectFolderType(uri: vscode.Uri): KvFolderType {
		const settings = readKvEditorSettings();
		const entry = settings ? findKvEntryForUri(uri, settings) : undefined;
		return entry?.type ?? 'custom';
	}

	private async buildTextureMenuResponse(
		webview: vscode.Webview,
		folderType: KvFolderType,
		entry: KvEditorEntry | undefined,
		documentPath?: string,
	): Promise<TextureMenuResponsePayload> {
		const addonImagesRoot = this.resolveAddonImagesRoot(documentPath ?? entry?.resolvedPath ?? '', entry);
		const extensionSpellRoots = [path.join(this.extensionImagesRoot, 'spellicons')];
		const extensionItemRoots = [path.join(this.extensionImagesRoot, 'items')];
		const addonSpellRoots = addonImagesRoot ? [path.join(addonImagesRoot, 'spellicons')] : [];
		const addonItemRoots = addonImagesRoot ? [path.join(addonImagesRoot, 'items')] : [];
		const extensionSpellIcons = await this.collectIconsForRoots(extensionSpellRoots, 'spell', 'extension', webview);
		const extensionItemIcons = await this.collectIconsForRoots(extensionItemRoots, 'item', 'extension', webview);
		const addonSpellIcons = await this.collectIconsForRoots(addonSpellRoots, 'spell', 'addon', webview);
		const addonItemIcons = await this.collectIconsForRoots(addonItemRoots, 'item', 'addon', webview);
		const allIcons = [...extensionSpellIcons, ...extensionItemIcons, ...addonSpellIcons, ...addonItemIcons];
		const defaultKind = folderType === 'item' ? 'item' : 'spell';
		const heroFilters = await this.collectHeroFilters(webview);
		return {
			folderType,
			defaultKind,
			icons: allIcons,
			heroFilters: heroFilters.length ? heroFilters : undefined,
		};
	}

	private async collectIconsForRoots(
		roots: string[],
		kind: TextureKind,
		source: TextureSource,
		webview: vscode.Webview,
	): Promise<TextureMenuIcon[]> {
		const results: TextureMenuIcon[] = [];
		for (const rawRoot of roots) {
			if (!rawRoot) {
				continue;
			}
			const normalizedRoot = path.normalize(rawRoot);
			if (!this.pathExists(normalizedRoot)) {
				continue;
			}
			const cacheKey = `${source}|${kind}|${normalizedRoot}`;
			let cached = this.textureMenuCache.get(cacheKey);
			if (!cached) {
				cached = await this.scanTextureDirectory(normalizedRoot, kind, source);
				this.textureMenuCache.set(cacheKey, cached);
			}
			for (const icon of cached) {
				results.push({
					...icon,
					uri: webview.asWebviewUri(vscode.Uri.file(icon.filePath)).toString(),
				});
			}
		}
		return results;
	}

	private async scanTextureDirectory(
		root: string,
		kind: TextureKind,
		source: TextureSource,
	): Promise<TextureMenuRawIcon[]> {
		const results: TextureMenuRawIcon[] = [];
		const stack: Array<{ dir: string; relative: string; depth: number; }> = [{ dir: root, relative: '', depth: 0 }];
		while (stack.length) {
			const current = stack.pop()!;
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
			} catch (error) {
				continue;
			}
			for (const entry of entries) {
				const fullPath = path.join(current.dir, entry.name);
				const relativePath = current.relative ? path.join(current.relative, entry.name) : entry.name;
				if (entry.isDirectory()) {
					stack.push({ dir: fullPath, relative: relativePath, depth: current.depth + 1 });
					continue;
				}
				if (!this.isSupportedImage(entry.name)) {
					continue;
				}
				const icon = this.buildRawIconData(root, relativePath, fullPath, kind, source);
				if (icon) {
					results.push(icon);
				}
			}
		}
		return results;
	}

	private isSupportedImage(fileName: string): boolean {
		return /\.(png|jpg|jpeg|webp)$/i.test(fileName);
	}

	private buildRawIconData(
		root: string,
		relativePathInput: string,
		fullPath: string,
		kind: TextureKind,
		source: TextureSource,
	): TextureMenuRawIcon | undefined {
		const normalizedRelative = relativePathInput.replace(/\\/g, '/');
		const withoutExt = normalizedRelative.replace(/\.[^.]+$/u, '');
		const trimmedPath = withoutExt.replace(/_png$/i, '');
		const segments = trimmedPath.split('/').filter(Boolean);
		if (!segments.length) {
			return undefined;
		}
		const heroSlug = kind === 'spell' ? segments[0].toLowerCase() : undefined;
		const textureName = trimmedPath.toLowerCase();
		if (!textureName) {
			return undefined;
		}
		const label = segments[segments.length - 1];
		const searchParts = new Set<string>();
		searchParts.add(textureName);
		searchParts.add(trimmedPath);
		searchParts.add(withoutExt);
		searchParts.add(segments.map((segment) => segment.replace(/_/g, ' ')).join(' '));
		if (heroSlug) {
			searchParts.add(heroSlug);
		}
		const searchKey = Array.from(searchParts)
			.map((part) => part.replace(/[\\/_]+/g, ' '))
			.join(' ')
			.toLowerCase();
		return {
			filePath: fullPath,
			textureName,
			label,
			relativePath: normalizedRelative,
			searchKey,
			source,
			kind,
			hero: heroSlug,
		};
	}

	private async collectHeroFilters(webview: vscode.Webview): Promise<TextureMenuHeroDisplay[]> {
		if (this.heroFilterCache) {
			return this.heroFilterCache.map((hero) => ({
				id: hero.id,
				name: hero.name,
				searchTerm: hero.searchTerm,
				uri: webview.asWebviewUri(vscode.Uri.file(hero.filePath)).toString(),
				attribute: hero.attribute,
			}));
		}
		// prefer icons subfolder for small avatars
		const iconsSub = path.join(this.extensionImagesRoot, 'heroes_icon', 'icons');
		const heroesDir = this.pathExists(iconsSub) ? iconsSub : path.join(this.extensionImagesRoot, 'heroes_icon');
		if (!this.pathExists(heroesDir)) {
			this.heroFilterCache = [];
			return [];
		}

		// build attribute map from resource/npc/npc_heroes.txt
		const attributeMap: Record<string, string | undefined> = {};
		try {
			const heroesTxt = this.context.asAbsolutePath(path.join('resource', 'npc', 'npc_heroes.txt'));
			if (this.pathExists(heroesTxt)) {
				const raw = await fs.promises.readFile(heroesTxt, 'utf8');
				const attrRegex = /"(npc_dota_hero_[a-z0-9_]+)"[\s\S]*?"AttributePrimary"\s+"(DOTA_ATTRIBUTE_[A-Z]+)"/gi;
				let m: RegExpExecArray | null;
				while ((m = attrRegex.exec(raw))) {
					attributeMap[m[1].toLowerCase()] = m[2];
				}
			}
		} catch (e) {
			// ignore
		}

		const heroes: TextureMenuHeroCache[] = [];
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(heroesDir, { withFileTypes: true });
		} catch (error) {
			this.heroFilterCache = [];
			return [];
		}
		for (const entry of entries) {
			if (!entry.isFile() || !this.isSupportedImage(entry.name)) {
				continue;
			}
			const fullPath = path.join(heroesDir, entry.name);
			const baseName = entry.name.replace(/\.[^.]+$/u, '');
			const withoutSuffix = baseName.replace(/_png$/i, '');
			const slug = withoutSuffix.replace(/^npc_dota_hero_/i, '').replace(/_/g, ' ').trim();
			const searchTerm = slug || withoutSuffix.replace(/_/g, ' ') || baseName;
			const label = this.toTitleCase(searchTerm);
			let heroKey = withoutSuffix.toLowerCase();
			if (!heroKey.startsWith('npc_dota_hero_')) {
				heroKey = `npc_dota_hero_${heroKey}`;
			}
			heroes.push({
				id: baseName,
				name: label,
				searchTerm,
				filePath: fullPath,
				attribute: attributeMap[heroKey],
			});
		}
		heroes.sort((a, b) => a.name.localeCompare(b.name));
		this.heroFilterCache = heroes;
		return heroes.map((hero) => ({
			id: hero.id,
			name: hero.name,
			searchTerm: hero.searchTerm,
			uri: webview.asWebviewUri(vscode.Uri.file(hero.filePath)).toString(),
			attribute: hero.attribute,
		}));
	}

	private toTitleCase(value: string): string {
		if (!value) {
			return '';
		}
		return value
			.split(/\s+/)
			.filter(Boolean)
			.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
			.join(' ');
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
					let abilityValues: AbilityValuesEntry[] | undefined;
					for (const [key, field] of Object.entries(entry)) {
						if (key === 'AbilityValues' && this.isPlainObject(field)) {
							if (!columnOrder.includes(key)) {
								columnOrder.push(key);
							}
							abilityValues = this.parseAbilityValuesField(field as Record<string, unknown>);
							rowValues[key] = '';
							continue;
						}
						if (this.isPlainObject(field)) {
							// other nested blocks are skipped for now
							continue;
						}
						if (!columnOrder.includes(key)) {
							columnOrder.push(key);
						}
						rowValues[key] = this.coerceKvScalar(field);
					}
					return abilityValues && abilityValues.length
						? { id, values: rowValues, abilityValues }
						: { id, values: rowValues };
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

	private isPlainObject(value: unknown): value is Record<string, unknown> {
		return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
	}

	private coerceKvScalar(value: unknown): string {
		if (value === undefined || value === null) {
			return '';
		}
		if (typeof value === 'string') {
			return value;
		}
		if (typeof value === 'number' || typeof value === 'boolean') {
			return String(value);
		}
		return String(value);
	}

	private parseAbilityValuesField(field: Record<string, unknown>): AbilityValuesEntry[] {
		const entries: AbilityValuesEntry[] = [];
		for (const [entryKey, entryValue] of Object.entries(field)) {
			if (this.isPlainObject(entryValue)) {
				const block = entryValue as Record<string, unknown>;
				const baseValue = this.coerceKvScalar(block.value);
				const modifiers: AbilityValuesModifier[] = [];
				for (const [modifierKey, modifierValue] of Object.entries(block)) {
					if (modifierKey === 'value') {
						continue;
					}
					modifiers.push({
						key: modifierKey,
						value: this.coerceKvScalar(modifierValue),
					});
				}
				entries.push({
					key: entryKey,
					originalKey: entryKey,
					value: baseValue,
					type: 'object',
					modifiers,
				});
				continue;
			}
			entries.push({
				key: entryKey,
				originalKey: entryKey,
				value: this.coerceKvScalar(entryValue),
				type: 'scalar',
				modifiers: [],
			});
		}
		return entries;
	}

	private buildTexturePreviews(
		document: vscode.TextDocument,
		rows: ParsedKvRow[] = [],
		webview: vscode.Webview,
		entry: KvEditorEntry | undefined,
	): Record<string, TexturePreviewPayload> {
		if (!rows.length) {
			return {};
		}
		const previewMap: Record<string, TexturePreviewPayload> = {};
		const addonImagesRoot = this.resolveAddonImagesRoot(document.uri.fsPath, entry);
		for (const row of rows) {
			const rowId = typeof row.id === 'string' ? row.id : undefined;
			if (!rowId) {
				continue;
			}
			const textureName = row.values?.AbilityTextureName;
			if (!textureName || typeof textureName !== 'string' || !textureName.trim()) {
				continue;
			}
			const asset = this.findTextureAsset(textureName, addonImagesRoot, entry);
			if (!asset) {
				continue;
			}
			const iconUri = webview.asWebviewUri(vscode.Uri.file(asset.fullPath)).toString();
			previewMap[rowId] = {
				uri: iconUri,
				kind: asset.kind,
				source: asset.source,
				fileName: path.basename(asset.fullPath),
			};
		}
		return previewMap;
	}

	private resolveAddonImagesRoot(documentPath: string, entry: KvEditorEntry | undefined): string | undefined {
		const candidates = new Set<string>();
		// if (entry?.isDirectory) {
		// 	const normalizedEntry = path.normalize(entry.resolvedPath);
		// 	if (/images?$/i.test(path.basename(normalizedEntry))) {
		// 		candidates.add(normalizedEntry);
		// 	}
		// }
		// const entryContentRoot = this.deriveAddonContentRoot(entry?.resolvedPath);
		// if (entryContentRoot) {
		// 	candidates.add(path.join(entryContentRoot, 'panorama', 'images'));
		// }
		// const documentContentRoot = this.deriveAddonContentRoot(documentPath);
		// if (documentContentRoot) {
		// 	candidates.add(path.join(documentContentRoot, 'panorama', 'images'));
		// }
		// const contentDir = getContentDir();
		// if (contentDir) {
		// 	candidates.add(path.join(path.normalize(contentDir), 'panorama', 'images'));
		// }
		const gameDir = getGameDir();
		if (gameDir) {
			candidates.add(path.join(path.normalize(gameDir), 'resource', 'flash3', 'images'));
		}
		for (const candidate of candidates) {
			if (this.pathExists(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}
	private resolveAddonLocalizationRoot(documentPath: string, entry: KvEditorEntry | undefined): string | undefined {
		const candidates = new Set<string>();
		const localizationFiles = this.getLocalizationFileCandidates();
		const entryContentRoot = this.deriveAddonContentRoot(entry?.resolvedPath);
		if (entryContentRoot) {
			for (const fileName of localizationFiles) {
				candidates.add(path.join(entryContentRoot, 'resource', fileName));
				const gameRoot = this.deriveAddonGameRoot(entryContentRoot);
				if (gameRoot) {
					candidates.add(path.join(gameRoot, 'resource', fileName));
				}
			}
		}
		const documentContentRoot = this.deriveAddonContentRoot(documentPath);
		if (documentContentRoot) {
			for (const fileName of localizationFiles) {
				candidates.add(path.join(documentContentRoot, 'resource', fileName));
				const gameRoot = this.deriveAddonGameRoot(documentContentRoot);
				if (gameRoot) {
					candidates.add(path.join(gameRoot, 'resource', fileName));
				}
			}
		}
		const contentDir = getContentDir();
		if (contentDir) {
			for (const fileName of localizationFiles) {
				candidates.add(path.join(path.normalize(contentDir), 'resource', fileName));
			}
		}
		const gameDir = getGameDir();
		if (gameDir) {
			for (const fileName of localizationFiles) {
				candidates.add(path.join(path.normalize(gameDir), 'resource', fileName));
			}
		}
		for (const candidate of candidates) {
			if (this.pathExists(candidate)) {
				return candidate;
			}
		}
		return undefined;
	}

	private getLocalizationFileCandidates(): string[] {
		const language = (vscode.env.language ?? '').toLowerCase();
		const mapping: Record<string, string> = {
			'zh-cn': 'addon_schinese.txt',
			'zh-hans': 'addon_schinese.txt',
			'zh': 'addon_schinese.txt',
			'en': 'addon_english.txt',
			'en-us': 'addon_english.txt',
			'en-gb': 'addon_english.txt',
			'ru': 'addon_russian.txt',
			'ru-ru': 'addon_russian.txt',
		};
		const candidates: string[] = [];
		const pushUnique = (value: string | undefined) => {
			if (value && !candidates.includes(value)) {
				candidates.push(value);
			}
		};
		pushUnique(mapping[language]);
		const baseLanguage = language.split('-')[0];
		if (baseLanguage && baseLanguage !== language) {
			pushUnique(mapping[baseLanguage]);
		}
		pushUnique('addon_schinese.txt');
		pushUnique('addon_english.txt');
		pushUnique('addon_russian.txt');
		return candidates;
	}

	private deriveAddonContentRoot(targetPath: string | undefined): string | undefined {
		if (!targetPath) {
			return undefined;
		}

		const normalized = path.normalize(targetPath);
		const forward = normalized.replace(/\\/g, '/');
		const lower = forward.toLowerCase();
		const gameMarker = '/game/dota_addons/';
		const gameIndex = lower.indexOf(gameMarker);
		if (gameIndex >= 0) {
			const base = forward.slice(0, gameIndex);
			const remaining = forward.slice(gameIndex + gameMarker.length);
			const addonName = remaining.split('/')[0];
			if (addonName) {
				return path.normalize(`${base}/content/dota_addons/${addonName}`);
			}
		}
		const contentMarker = '/content/dota_addons/';
		const contentIndex = lower.indexOf(contentMarker);
		if (contentIndex >= 0) {
			const base = forward.slice(0, contentIndex);
			const remaining = forward.slice(contentIndex + contentMarker.length);
			const addonName = remaining.split('/')[0];
			if (addonName) {
				return path.normalize(`${base}/content/dota_addons/${addonName}`);
			}
		}
		return undefined;
	}

	private deriveAddonGameRoot(contentRoot: string | undefined): string | undefined {
		if (!contentRoot) {
			return undefined;
		}
		const normalized = path.normalize(contentRoot);
		const segments = normalized.split(path.sep);
		const contentIndex = segments.findIndex((segment) => segment.toLowerCase() === 'content');
		if (contentIndex >= 0 && segments.length > contentIndex + 1 && segments[contentIndex + 1].toLowerCase() === 'dota_addons') {
			segments[contentIndex] = 'game';
			return segments.join(path.sep);
		}
		return undefined;
	}

	private loadLocalizationTokens(localizationPath: string): LocalizationTokenMap | undefined {
		try {
			const stat = fs.statSync(localizationPath);
			const cached = this.localizationCache.get(localizationPath);
			if (cached && cached.mtimeMs === stat.mtimeMs) {
				return cached.tokens;
			}
			const raw = fs.readFileSync(localizationPath, 'utf8');
			const parsed = readKeyValue2(raw ?? '');
			const tokensSection = (parsed?.lang as Record<string, unknown> | undefined)?.Tokens;
			if (!tokensSection || typeof tokensSection !== 'object') {
				return cached?.tokens;
			}
			const entries = tokensSection as Record<string, unknown>;
			const tokens: LocalizationTokenMap = new Map();
			for (const [key, value] of Object.entries(entries)) {
				if (typeof value === 'string') {
					tokens.set(key.toLowerCase(), value);
				}
			}
			this.localizationCache.set(localizationPath, {
				tokens,
				mtimeMs: stat.mtimeMs,
			});
			return tokens;
		} catch (error) {
			console.warn('[kvEditorProvider] Failed to load localization tokens:', error);
			return this.localizationCache.get(localizationPath)?.tokens;
		}
	}

	private findLocalizationToken(tokens: LocalizationTokenMap | undefined, candidateKeys: string[]): string | undefined {
		if (!tokens || !candidateKeys.length) {
			return undefined;
		}
		for (const key of candidateKeys) {
			const normalizedKey = typeof key === 'string' ? key.trim().toLowerCase() : '';
			if (!normalizedKey) {
				continue;
			}
			const value = tokens.get(normalizedKey);
			if (typeof value === 'string' && value.length > 0) {
				return value;
			}
		}
		return undefined;
	}

	private enrichRowsWithLocalization(
		rows: ParsedKvRow[],
		folderType: KvFolderType,
		documentPath: string,
		entry: KvEditorEntry | undefined,
	): void {
		if (!rows.length) {
			return;
		}
		const localizationPath = this.resolveAddonLocalizationRoot(documentPath, entry);
		if (!localizationPath) {
			return;
		}
		const tokens = this.loadLocalizationTokens(localizationPath);
		if (!tokens || !tokens.size) {
			return;
		}
		const isAbilityLike = folderType === 'ability' || folderType === 'item';
		for (const row of rows) {
			const rowId = typeof row.id === 'string' ? row.id.trim() : '';
			if (!rowId) {
				continue;
			}
			const localizationInfo: ParsedKvRowLocalization = {};
			if (isAbilityLike) {
				const baseKey = `dota_tooltip_ability_${rowId.toLowerCase()}`;
				const name = this.findLocalizationToken(tokens, [baseKey, rowId, `dota_tooltip_ability_${rowId}`]);
				if (name) {
					localizationInfo.name = name;
				}
				let description = this.findLocalizationToken(tokens, [
					`${baseKey}_description`,
					`${baseKey}_Description`,
					`dota_tooltip_ability_${rowId}_description`,
					`dota_tooltip_ability_${rowId}_Description`,
				]);
				if (description) {
					const replacements = this.buildLocalizationReplacementMap(row);
					description = this.applyLocalizationReplacements(description, replacements);
					localizationInfo.description = description;
				}
			} else {
				const name = this.findLocalizationToken(tokens, [rowId, rowId.toLowerCase()]);
				if (name) {
					localizationInfo.name = name;
				}
				const description = this.findLocalizationToken(tokens, [
					`${rowId}_description`,
					`${rowId}_Description`,
				]);
				if (description) {
					localizationInfo.description = description;
				}
			}
			if (localizationInfo.name || localizationInfo.description) {
				row.localization = localizationInfo;
			}
		}
	}

	private buildLocalizationReplacementMap(row: ParsedKvRow): Map<string, string> {
		const replacements = new Map<string, string>();
		for (const [key, value] of Object.entries(row.values ?? {})) {
			const normalizedKey = key.trim().toLowerCase();
			const normalizedValue = typeof value === 'string' ? value.trim() : '';
			if (normalizedKey && normalizedValue) {
				replacements.set(normalizedKey, normalizedValue);
			}
		}
		for (const entry of row.abilityValues ?? []) {
			const entryValue = (entry.value ?? '').trim();
			if (entryValue) {
				const entryKey = entry.key?.trim().toLowerCase();
				const originalKey = entry.originalKey?.trim().toLowerCase();
				if (entryKey) {
					replacements.set(entryKey, entryValue);
				}
				if (originalKey && originalKey !== entryKey) {
					replacements.set(originalKey, entryValue);
				}
			}
			for (const modifier of entry.modifiers ?? []) {
				const modifierKey = modifier.key?.trim().toLowerCase();
				const modifierValue = (modifier.value ?? '').trim();
				if (modifierKey && modifierValue) {
					replacements.set(modifierKey, modifierValue);
				}
			}
		}
		return replacements;
	}

	private applyLocalizationReplacements(input: string, replacements: Map<string, string>): string {
		if (!input || !replacements.size) {
			return input;
		}
		return input.replace(/%([^%]+)%/g, (match, token) => {
			const normalizedToken = typeof token === 'string' ? token.trim().toLowerCase() : '';
			if (!normalizedToken) {
				return match;
			}
			const replacement = replacements.get(normalizedToken);
			return replacement !== undefined ? replacement : match;
		});
	}

	private findTextureAsset(textureName: string, addonImagesRoot: string | undefined, entry: KvEditorEntry | undefined): TextureAssetMatch | undefined {
		const normalized = textureName.trim().replace(/\\/g, '/');
		if (!normalized) {
			return undefined;
		}
		const roots: TextureSearchRoot[] = [];
		if (addonImagesRoot && this.pathExists(addonImagesRoot)) {
			roots.push({ root: addonImagesRoot, source: 'addon' });
		}
		if (this.pathExists(this.extensionImagesRoot)) {
			roots.push({ root: this.extensionImagesRoot, source: 'extension' });
		}
		if (!roots.length) {
			return undefined;
		}
		const segments = normalized.split('/').filter(Boolean);
		if (!segments.length) {
			return undefined;
		}
		const baseNameSegment = segments[segments.length - 1];
		const hasExtension = /\.[a-z0-9]+$/i.test(baseNameSegment);
		const baseNameCore = hasExtension ? baseNameSegment.replace(/\.[a-z0-9]+$/i, '') : baseNameSegment;
		const originalExtension = hasExtension ? path.extname(baseNameSegment) : '';
		const firstSegment = segments[0];
		const baseDirProvided = firstSegment === 'items' || firstSegment === 'spellicons';
		const entryType = entry?.type ?? 'custom';
		let baseDirCandidates: string[];
		if (baseDirProvided) {
			baseDirCandidates = [firstSegment];
		} else if (entryType === 'item') {
			baseDirCandidates = ['items', 'spellicons'];
		} else if (entryType === 'ability') {
			baseDirCandidates = ['spellicons', 'items'];
		} else {
			baseDirCandidates = ['spellicons', 'items'];
		}
		const relativePathSegments = baseDirProvided ? segments.slice(1, -1) : segments.slice(0, -1);
		const baseNameVariants = this.buildBaseNameVariants(baseNameCore, entryType, hasExtension ? baseNameSegment : undefined);
		for (const root of roots) {
			const allowPluginSuffix = root.source === 'extension';
			const stripPngSuffix = root.source === 'addon';
			const extensionCandidates = this.buildExtensionCandidates(hasExtension, originalExtension);
			const candidateNames = this.buildCandidateNamesPerRoot(baseNameVariants, extensionCandidates, allowPluginSuffix, stripPngSuffix);
			for (const baseDir of baseDirCandidates) {
				const kind: TextureKind = baseDir === 'items' ? 'item' : 'spell';
				for (const candidateName of candidateNames) {
					const segmentsToJoin = [root.root, baseDir, ...relativePathSegments, candidateName].filter(Boolean);
					const candidatePath = path.join(...segmentsToJoin);
					if (!this.pathExists(candidatePath)) {
						continue;
					}
					return {
						fullPath: candidatePath,
						kind,
						source: root.source,
					};
				}
			}
		}
		return undefined;
	}

	private buildBaseNameVariants(baseNameCore: string, entryType: KvFolderType, baseNameSegment?: string): Set<string> {
		const variants = new Set<string>();
		variants.add(baseNameCore);
		if (baseNameSegment && baseNameSegment !== baseNameCore) {
			variants.add(baseNameSegment.replace(/\.[a-z0-9]+$/i, ''));
		}
		if (entryType === 'item') {
			const trimmed = baseNameCore.replace(/^item_/, '');
			if (trimmed && trimmed !== baseNameCore) {
				variants.add(trimmed);
			}
		}
		return variants;
	}

	private buildExtensionCandidates(hasExtension: boolean, originalExtension: string): string[] {
		if (hasExtension) {
			const normalized = originalExtension.toLowerCase();
			const candidates = new Set<string>([originalExtension]);
			if (normalized !== '.png') {
				candidates.add('.png');
			}
			if (normalized !== '.jpg') {
				candidates.add('.jpg');
			}
			return Array.from(candidates);
		}
		return ['', '.png', '.jpg', '.jpeg', '.webp'];
	}

	private buildCandidateNamesPerRoot(
		baseNameVariants: Set<string>,
		extensionCandidates: string[],
		allowPluginSuffix: boolean,
		stripPngSuffix: boolean,
	): string[] {
		const results = new Set<string>();
		for (const variant of baseNameVariants) {
			const coreCandidates = new Set<string>();
			coreCandidates.add(variant);
			if (stripPngSuffix && /_png$/i.test(variant)) {
				coreCandidates.add(variant.replace(/_png$/i, ''));
			}
			if (allowPluginSuffix && !/_png$/i.test(variant)) {
				coreCandidates.add(`${variant}_png`);
			}
			for (const core of coreCandidates) {
				for (const ext of extensionCandidates) {
					if (ext) {
						results.add(`${core}${ext}`);
					} else {
						results.add(core);
					}
				}
			}
		}
		return Array.from(results);
	}

	private pathExists(target: string | undefined): boolean {
		if (!target) {
			return false;
		}
		try {
			return fs.existsSync(target);
		} catch (error) {
			return false;
		}
	}

	private async handleAbilityValuesEditMessage(
		document: vscode.TextDocument,
		message?: KvEditorAbilityValuesEditMessage,
	): Promise<void> {
		if (!message || typeof message.id !== 'string' || !message.id) {
			return;
		}
		const normalizedEntries = (Array.isArray(message.entries) ? message.entries : [])
			.map((entry) => this.normalizeAbilityValuesEditEntry(entry))
			.filter((entry): entry is AbilityValuesEntry => Boolean(entry));
		const originalText = document.getText();
		const kvObject = readKeyValue2(originalText ?? '');
		const header = Object.keys(kvObject)[0];
		if (!header) {
			throw new Error('无法解析 KV 根节点，修改未保存。');
		}
		const block = kvObject[header];
		if (!block || typeof block !== 'object') {
			throw new Error('当前 KV 结构不支持 AbilityValues 编辑。');
		}
		const row = (block as Record<string, unknown>)[message.id];
		if (!row || typeof row !== 'object') {
			throw new Error(`未找到条目 "${message.id}"，修改未保存。`);
		}
		const record = row as Record<string, unknown>;
		if (!normalizedEntries.length) {
			delete record.AbilityValues;
		} else {
			const abilityBlock: Record<string, unknown> = {};
			for (const entry of normalizedEntries) {
				const key = entry.key;
				if (!key) {
					continue;
				}
				if (entry.type === 'scalar' && (!entry.modifiers || !entry.modifiers.length)) {
					abilityBlock[key] = entry.value ?? '';
					continue;
				}
				const blockValue: Record<string, string> = {};
				blockValue.value = entry.value ?? '';
				for (const modifier of entry.modifiers ?? []) {
					if (!modifier.key) {
						continue;
					}
					blockValue[modifier.key] = modifier.value ?? '';
				}
				abilityBlock[key] = blockValue;
			}
			if (Object.keys(abilityBlock).length) {
				record.AbilityValues = abilityBlock;
			} else {
				delete record.AbilityValues;
			}
		}
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

	private normalizeAbilityValuesEditEntry(entry: AbilityValuesEditEntry | undefined): AbilityValuesEntry | undefined {
		if (!entry || typeof entry.key !== 'string') {
			return undefined;
		}
		const key = entry.key.trim();
		if (!key) {
			return undefined;
		}
		const rawValue = entry.value;
		const normalizedValue = typeof rawValue === 'string' ? rawValue.trim() : this.coerceKvScalar(rawValue);
		const modifiersRaw = Array.isArray(entry.modifiers) ? entry.modifiers : [];
		const modifiers: AbilityValuesModifier[] = modifiersRaw
			.map((modifier) => {
				if (!modifier || typeof modifier.key !== 'string') {
					return undefined;
				}
				const modifierKey = modifier.key.trim();
				if (!modifierKey) {
					return undefined;
				}
				const modifierValueRaw = modifier.value;
				const modifierValue = typeof modifierValueRaw === 'string'
					? modifierValueRaw.trim()
					: this.coerceKvScalar(modifierValueRaw);
				return {
					key: modifierKey,
					value: modifierValue,
				};
			})
			.filter((modifier): modifier is AbilityValuesModifier => Boolean(modifier));
		const normalizedType: AbilityValuesEntryType = entry.type === 'scalar' && modifiers.length === 0
			? 'scalar'
			: 'object';
		const originalKey = typeof entry.originalKey === 'string' && entry.originalKey.trim().length
			? entry.originalKey.trim()
			: key;
		return {
			key,
			originalKey,
			value: normalizedValue,
			type: normalizedType,
			modifiers,
		};
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

	private async handleBulkEditMessage(document: vscode.TextDocument, message?: KvEditorBulkEditMessage): Promise<void> {
		const rawEdits = Array.isArray(message?.edits) ? message.edits : [];
		const edits = rawEdits
			.filter((edit): edit is KvEditorEditMessage => Boolean(edit && edit.id && edit.key && edit.key !== 'id'));
		if (!edits.length) {
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
		let mutated = false;
		for (const edit of edits) {
			const row = (block as Record<string, unknown>)[edit.id];
			if (!row || typeof row !== 'object') {
				continue;
			}
			const normalizedKey = edit.key;
			const normalizedValue = edit.value === undefined || edit.value === null ? '' : String(edit.value);
			const record = row as Record<string, unknown>;
			const previousValue = record[normalizedKey];
			if ((previousValue === undefined || previousValue === null ? '' : String(previousValue)) === normalizedValue) {
				continue;
			}
			record[normalizedKey] = normalizedValue;
			mutated = true;
		}
		if (!mutated) {
			return;
		}
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

	private async handleOpenScriptFile(
		document: vscode.TextDocument,
		payload: OpenScriptFileMessage | undefined,
	): Promise<void> {
		if (!payload) {
			return;
		}
		const rawScriptPath = typeof payload.scriptPath === 'string' ? payload.scriptPath.trim() : '';
		if (!rawScriptPath) {
			void vscode.window.showInformationMessage('当前单元格没有脚本路径。');
			return;
		}
		const folderType = payload.folderType ?? this.detectFolderType(document.uri);
		if (folderType !== 'ability' && folderType !== 'item') {
			void vscode.window.showWarningMessage('当前 KV 类型不支持脚本跳转。');
			return;
		}
		const useTypescript = Boolean(vscode.workspace.getConfiguration().get('dota2-tools.A6.Kv to lua generate typescript'));
		const baseDir = useTypescript ? getContentDir() : getGameDir();
		if (!baseDir) {
			void vscode.window.showWarningMessage('未配置 Dota 2 目录，无法定位脚本文件。');
			return;
		}
		const extension = useTypescript ? '.ts' : '.lua';
		let normalized = rawScriptPath.replace(/\\/g, '/').trim();
		if (!normalized) {
			void vscode.window.showWarningMessage('无法解析脚本路径。');
			return;
		}
		normalized = normalized.replace(/^scripts\/vscripts\//i, '');
		normalized = normalized.replace(/^vscripts\//i, '');
		normalized = normalized.replace(/\.(lua|ts)$/i, '');
		const candidatePath = path.join(baseDir, 'scripts', 'vscripts', `${normalized}${extension}`);
		try {
			await fs.promises.access(candidatePath, fs.constants.F_OK);
		} catch (error) {
			void vscode.window.showWarningMessage(`未找到脚本文件：${candidatePath}`);
			return;
		}
		try {
			const scriptDocument = await vscode.workspace.openTextDocument(candidatePath);
			await vscode.window.showTextDocument(scriptDocument, { preview: false });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			void vscode.window.showErrorMessage(`无法打开脚本文件：${message}`);
		}
	}

	private async handleReorderRows(document: vscode.TextDocument, payload: KvEditorReorderMessage | undefined): Promise<void> {
		if (!payload) {
			return;
		}
		const sourceId = typeof payload.sourceId === 'string' ? payload.sourceId : '';
		const sourceIndex = typeof payload.sourceIndex === 'number' ? payload.sourceIndex : -1;
		const targetIndex = typeof payload.targetIndex === 'number' ? payload.targetIndex : -1;
		if (!sourceId || sourceIndex < 0 || targetIndex < 0 || !Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) {
			return;
		}
		if (sourceIndex === targetIndex) {
			return;
		}
		const originalText = document.getText();
		const kvObject = readKeyValue2(originalText ?? '');
		const header = Object.keys(kvObject)[0];
		if (!header) {
			throw new Error('无法解析 KV 根节点，未执行排序。');
		}
		const blockRaw = kvObject[header];
		if (!blockRaw || typeof blockRaw !== 'object') {
			throw new Error('当前 KV 结构不支持行排序。');
		}
		const block = blockRaw as Record<string, unknown>;
		const entries = Object.entries(block);
		if (!entries.length) {
			return;
		}
		const rowEntryIndices: number[] = [];
		const rowEntries: Array<[string, unknown]> = [];
		entries.forEach((entry, index) => {
			const [, value] = entry;
			if (this.isPlainObject(value)) {
				rowEntryIndices.push(index);
				rowEntries.push(entry);
			}
		});
		if (!rowEntries.length) {
			return;
		}
		const actualSourceIndex = rowEntries.findIndex(([key]) => key === sourceId);
		if (actualSourceIndex === -1) {
			return;
		}
		const totalRows = rowEntries.length;
		let finalTargetIndex = Math.max(0, Math.min(targetIndex, totalRows - 1));
		if (finalTargetIndex === actualSourceIndex) {
			return;
		}
		const removed = rowEntries.splice(actualSourceIndex, 1);
		if (!removed.length) {
			return;
		}
		const movedEntry = removed[0];
		const insertionIndex = Math.min(finalTargetIndex, rowEntries.length);
		rowEntries.splice(insertionIndex, 0, movedEntry);
		const reorderedBlock: Record<string, unknown> = {};
		const rowIndexSet = new Set(rowEntryIndices);
		let rowPointer = 0;
		entries.forEach((entry, index) => {
			if (rowIndexSet.has(index)) {
				const nextRow = rowEntries[rowPointer++];
				if (nextRow) {
					reorderedBlock[nextRow[0]] = nextRow[1];
				} else {
					reorderedBlock[entry[0]] = entry[1];
				}
			} else {
				reorderedBlock[entry[0]] = entry[1];
			}
		});
		kvObject[header] = reorderedBlock;
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

	private async handleReorderColumns(document: vscode.TextDocument, payload: KvEditorColumnReorderMessage | undefined): Promise<void> {
		if (!payload) {
			return;
		}
		const sourceKey = typeof payload.sourceKey === 'string' ? payload.sourceKey : '';
		const sourceIndex = typeof payload.sourceIndex === 'number' ? payload.sourceIndex : -1;
		const targetIndex = typeof payload.targetIndex === 'number' ? payload.targetIndex : -1;
		if (!sourceKey || sourceIndex <= 0 || targetIndex <= 0 || !Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) {
			return;
		}
		const originalText = document.getText();
		const parsed = this.parseKv(originalText);
		if (!parsed.columns.length) {
			return;
		}
		const columns = parsed.columns.slice();
		const sourcePosition = columns.indexOf(sourceKey);
		if (sourcePosition <= 0 || sourcePosition !== sourceIndex) {
			return;
		}
		const kvObject = readKeyValue2(originalText ?? '');
		const header = Object.keys(kvObject)[0];
		if (!header) {
			throw new Error('无法解析 KV 根节点，未执行列排序。');
		}
		const blockRaw = kvObject[header];
		if (!blockRaw || typeof blockRaw !== 'object') {
			throw new Error('当前 KV 结构不支持列排序。');
		}
		const totalColumns = columns.length;
		let finalTargetIndex = Math.max(1, Math.min(targetIndex, totalColumns - 1));
		if (finalTargetIndex === sourcePosition) {
			return;
		}
		const [movedKey] = columns.splice(sourcePosition, 1);
		columns.splice(finalTargetIndex, 0, movedKey);
		const orderedKeys = columns.filter((key) => key !== 'id');
		const block = blockRaw as Record<string, unknown>;
		const entries = Object.entries(block);
		if (!entries.length) {
			return;
		}
		const reorderedBlock: Record<string, unknown> = {};
		for (const [rowKey, rowValue] of entries) {
			if (this.isPlainObject(rowValue)) {
				reorderedBlock[rowKey] = this.reorderRowColumns(rowValue as Record<string, unknown>, orderedKeys);
			} else {
				reorderedBlock[rowKey] = rowValue;
			}
		}
		kvObject[header] = reorderedBlock;
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

	private async handleSaveColumnWidths(
		document: vscode.TextDocument,
		message?: KvEditorSaveColumnWidthsMessage,
	): Promise<void> {
		if (!message || typeof message !== 'object' || !message.widths) {
			return;
		}
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			return;
		}
		const documentKey = this.getDocumentSettingsKey(document.uri, workspaceFolder);
		if (!documentKey) {
			return;
		}
		const sanitized = this.sanitizeColumnWidthMap(message.widths);
		const settings = this.copyUserSettings(this.getUserSettings(workspaceFolder));
		if (!sanitized || !Object.keys(sanitized).length) {
			if (settings.files[documentKey]) {
				delete settings.files[documentKey];
				this.writeUserSettings(workspaceFolder, settings);
			}
			return;
		}
		const existingEntry = settings.files[documentKey];
		const existingWidths = existingEntry?.columnWidths ? { ...existingEntry.columnWidths } : {};
		const mergedWidths = { ...existingWidths, ...sanitized };
		if (!Object.keys(mergedWidths).length) {
			if (settings.files[documentKey]) {
				delete settings.files[documentKey];
				this.writeUserSettings(workspaceFolder, settings);
			}
			return;
		}
		settings.files[documentKey] = {
			...existingEntry,
			columnWidths: mergedWidths,
		};
		this.writeUserSettings(workspaceFolder, settings);
	}

	private loadColumnLayout(document: vscode.TextDocument): KvEditorColumnLayout | undefined {
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
		if (!workspaceFolder) {
			return undefined;
		}
		const documentKey = this.getDocumentSettingsKey(document.uri, workspaceFolder);
		if (!documentKey) {
			return undefined;
		}
		const settings = this.getUserSettings(workspaceFolder);
		const entry = settings.files[documentKey];
		if (!entry?.columnWidths || !Object.keys(entry.columnWidths).length) {
			return undefined;
		}
		return {
			columnWidths: { ...entry.columnWidths },
		};
	}

	private getUserSettings(folder: vscode.WorkspaceFolder): KvEditorUserSettings {
		const cacheKey = folder.uri.fsPath;
		const cached = this.userSettingsCache.get(cacheKey);
		if (cached) {
			return cached;
		}
		const settings = this.readUserSettingsFromDisk(folder);
		this.userSettingsCache.set(cacheKey, settings);
		return settings;
	}

	private copyUserSettings(source: KvEditorUserSettings): KvEditorUserSettings {
		const files: Record<string, KvEditorUserFileSettings> = {};
		for (const [key, value] of Object.entries(source.files) as Array<[string, KvEditorUserFileSettings]>) {
			files[key] = {
				columnWidths: value.columnWidths ? { ...value.columnWidths } : undefined,
			};
		}
		return { files };
	}

	private readUserSettingsFromDisk(folder: vscode.WorkspaceFolder): KvEditorUserSettings {
		const settingsPath = this.getUserSettingsPath(folder);
		if (!this.pathExists(settingsPath)) {
			return { files: {} };
		}
		try {
			const raw = fs.readFileSync(settingsPath, 'utf8');
			const parsed = JSON.parse(raw) as unknown;
			return this.normalizeUserSettings(parsed);
		} catch (error) {
			console.warn('[kvEditorProvider] Failed to read column width settings:', error);
			return { files: {} };
		}
	}

	private normalizeUserSettings(raw: unknown): KvEditorUserSettings {
		const result: KvEditorUserSettings = { files: {} };
		if (!raw || typeof raw !== 'object') {
			return result;
		}
		const container = raw as Record<string, unknown>;
		const filesSection = container.files;
		if (!filesSection || typeof filesSection !== 'object') {
			return result;
		}
		for (const [key, entry] of Object.entries(filesSection as Record<string, unknown>)) {
			if (typeof key !== 'string' || !key) {
				continue;
			}
			if (!entry || typeof entry !== 'object') {
				continue;
			}
			const recordEntry = entry as Record<string, unknown>;
			const columnWidths = this.sanitizeColumnWidthMap(recordEntry.columnWidths);
			if (columnWidths && Object.keys(columnWidths).length) {
				result.files[key] = { columnWidths };
			}
		}
		return result;
	}

	private writeUserSettings(folder: vscode.WorkspaceFolder, settings: KvEditorUserSettings): void {
		const targetPath = this.getUserSettingsPath(folder);
		const dir = path.dirname(targetPath);
		try {
			fs.mkdirSync(dir, { recursive: true });
			const serialized = this.serializeUserSettings(settings);
			fs.writeFileSync(targetPath, `${serialized}\n`, 'utf8');
			this.userSettingsCache.set(folder.uri.fsPath, this.copyUserSettings(settings));
		} catch (error) {
			console.warn('[kvEditorProvider] Failed to write column width settings:', error);
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`保存列宽失败：${message}`);
		}
	}

	private serializeUserSettings(settings: KvEditorUserSettings): string {
		const files: Record<string, KvEditorUserFileSettings> = {};
		for (const [key, value] of Object.entries(settings.files) as Array<[string, KvEditorUserFileSettings]>) {
			if (!value.columnWidths || !Object.keys(value.columnWidths).length) {
				continue;
			}
			const sorted = Object.keys(value.columnWidths)
				.sort()
				.reduce<Record<string, number>>((acc, column) => {
					acc[column] = value.columnWidths![column];
					return acc;
				}, {});
			files[key] = { columnWidths: sorted };
		}
		return JSON.stringify({ files }, null, 2);
	}

	private sanitizeColumnWidthMap(raw: unknown): Record<string, number> | undefined {
		if (!raw || typeof raw !== 'object') {
			return undefined;
		}
		const result: Record<string, number> = {};
		for (const [column, value] of Object.entries(raw as Record<string, unknown>)) {
			if (column === '__rowNumber') {
				continue;
			}
			const numeric = typeof value === 'number' ? value : Number(value);
			if (!Number.isFinite(numeric)) {
				continue;
			}
			const rounded = Math.max(32, Math.round(numeric));
			result[column] = rounded;
		}
		return Object.keys(result).length ? result : undefined;
	}

	private getUserSettingsPath(folder: vscode.WorkspaceFolder): string {
		return path.join(folder.uri.fsPath, '.vscode', 'kv_edotir_user_setting.json');
	}

	private getDocumentSettingsKey(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string | undefined {
		let relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
		if (!relativePath) {
			relativePath = path.basename(uri.fsPath);
		}
		if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
			return undefined;
		}
		const normalized = relativePath.split(path.sep).filter(Boolean).join('/');
		return normalized || path.basename(uri.fsPath);
	}

	private reorderRowColumns(row: Record<string, unknown>, orderedKeys: string[]): Record<string, unknown> {
		if (!orderedKeys.length) {
			return row;
		}
		const entries = Object.entries(row);
		if (!entries.length) {
			return row;
		}
		const remaining = new Map(entries);
		const reordered: Record<string, unknown> = {};
		for (const key of orderedKeys) {
			if (!remaining.has(key)) {
				continue;
			}
			reordered[key] = remaining.get(key) as unknown;
			remaining.delete(key);
		}
		for (const [key, value] of entries) {
			if (remaining.has(key)) {
				reordered[key] = value;
				remaining.delete(key);
			}
		}
		return reordered;
	}

}

interface KvEditorPayload {
	fileName: string;
	documentKey?: string;
	folderType: KvFolderType;
	header: string;
	columns: string[];
	rows: ParsedKvRow[];
	error?: string;
	columnOptions: KvEditorColumnOptionResolvedMap;
	columnLayout?: KvEditorColumnLayout;
	texturePreviews: Record<string, TexturePreviewPayload>;
	scriptSupport: KvEditorScriptSupport;
}

interface ParsedKvTable {
	header: string;
	columns: string[];
	rows: ParsedKvRow[];
	error?: string;
}

interface ParsedKvRow {
	id: string;
	values: Record<string, string>;
	abilityValues?: AbilityValuesEntry[];
	localization?: ParsedKvRowLocalization;
}

interface ParsedKvRowLocalization {
	name?: string;
	description?: string;
}

type AbilityValuesEntryType = 'object' | 'scalar';

interface AbilityValuesEntry {
	key: string;
	originalKey: string;
	value: string;
	type: AbilityValuesEntryType;
	modifiers: AbilityValuesModifier[];
}

interface AbilityValuesModifier {
	key: string;
	value: string;
}

interface KvEditorEditMessage {
	id: string;
	key: string;
	value: string;
}

interface KvEditorBulkEditMessage {
	edits: KvEditorEditMessage[];
}

interface KvEditorAbilityValuesEditMessage {
	id: string;
	entries: AbilityValuesEditEntry[];
}

interface AbilityValuesEditEntry {
	key: string;
	originalKey?: string;
	value: string;
	type: AbilityValuesEntryType;
	modifiers?: AbilityValuesModifier[];
}

interface LocalizationCacheEntry {
	tokens: LocalizationTokenMap;
	mtimeMs: number;
}

type LocalizationTokenMap = Map<string, string>;
interface KvEditorReorderMessage {
	sourceId: string;
	sourceIndex: number;
	targetIndex: number;
}

interface KvEditorColumnReorderMessage {
	sourceKey: string;
	sourceIndex: number;
	targetIndex: number;
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

interface KvEditorColumnOptionOverride {
	options?: KvEditorColumnOption[];
	multiple?: boolean;
	separator?: string;
}

interface KvEditorColumnOptionSource extends KvEditorColumnOptionConfig {
	overrides?: Partial<Record<KvFolderType, KvEditorColumnOptionOverride>>;
}

type KvEditorColumnOptionResolvedMap = Record<string, KvEditorColumnOptionConfig>;

type KvEditorColumnOptionMap = Record<string, KvEditorColumnOptionSource>;

interface TexturePreviewPayload {
	uri: string;
	kind: TextureKind;
	source: 'extension' | 'addon';
	fileName: string;
}

interface KvEditorScriptSupport {
	applicable: boolean;
	baseReady: boolean;
	useTypescript: boolean;
}

type TextureKind = 'spell' | 'item';

interface TextureSearchRoot {
	root: string;
	source: 'extension' | 'addon';
}

interface TextureAssetMatch {
	fullPath: string;
	kind: TextureKind;
	source: 'extension' | 'addon';
}

type TextureSource = 'extension' | 'addon';

interface TextureMenuRequestMessage {
	requestId: string;
	folderType?: KvFolderType;
}

interface TextureMenuResponsePayload {
	folderType: KvFolderType;
	defaultKind: TextureKind;
	icons: TextureMenuIcon[];
	heroFilters?: TextureMenuHeroDisplay[];
}

interface TextureMenuRawIcon {
	filePath: string;
	textureName: string;
	label: string;
	relativePath: string;
	searchKey: string;
	source: TextureSource;
	kind: TextureKind;
	hero?: string;
}

interface TextureMenuIcon extends TextureMenuRawIcon {
	uri: string;
}

interface TextureMenuHeroCache {
	id: string;
	name: string;
	searchTerm: string;
	filePath: string;
	attribute?: string;
}

interface TextureMenuHeroDisplay {
	id: string;
	name: string;
	searchTerm: string;
	uri: string;
	attribute?: string;
}

interface OpenScriptFileMessage {
	scriptPath: string;
	folderType?: KvFolderType;
}

interface KvEditorColumnLayout {
	columnWidths?: Record<string, number>;
}

interface KvEditorSaveColumnWidthsMessage {
	widths: Record<string, number>;
}

interface KvEditorUserSettings {
	files: Record<string, KvEditorUserFileSettings>;
}

interface KvEditorUserFileSettings {
	columnWidths?: Record<string, number>;
}