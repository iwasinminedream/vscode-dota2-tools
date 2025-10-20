import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getGameDir } from '../module/addonInfo';
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
			if (message.type === 'edit') {
				const editMessage: KvEditorEditMessage | undefined = message.payload;
				this.handleEditMessage(document, editMessage).catch((error: unknown) => {
					const messageText = error instanceof Error ? error.message : String(error);
					vscode.window.showErrorMessage(messageText);
				});
			}
			if (message.type === 'requestTextureMenu') {
				const requestPayload: TextureMenuRequestMessage | undefined = message.payload;
				if (!requestPayload || typeof requestPayload.requestId !== 'string') {
					return;
				}
				void this.handleTextureMenuRequest(document, webviewPanel.webview, requestPayload);
			}
		});

		webviewPanel.onDidDispose(() => {
			changeDocumentSubscription.dispose();
			messageListener.dispose();
		});

		updateWebview();
	}

	private buildPayload(document: vscode.TextDocument, webview: vscode.Webview): KvEditorPayload {
		const settings = readKvEditorSettings();
		const entry = settings ? findKvEntryForUri(document.uri, settings) : undefined;
		const folderType: KvFolderType = entry?.type ?? 'custom';
		const parsed = this.parseKv(document.getText());
		return {
			fileName: path.basename(document.uri.fsPath),
			folderType,
			header: parsed.header,
			columns: parsed.columns,
			rows: parsed.rows,
			error: parsed.error,
			columnOptions: this.getResolvedColumnOptions(folderType),
			texturePreviews: this.buildTexturePreviews(document, parsed.rows, webview, entry),
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

	private buildTexturePreviews(
		document: vscode.TextDocument,
		rows: Array<{ id: string; values: Record<string, string>; }> = [],
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
	columnOptions: KvEditorColumnOptionResolvedMap;
	texturePreviews: Record<string, TexturePreviewPayload>;
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