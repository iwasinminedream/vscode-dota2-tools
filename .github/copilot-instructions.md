# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- **Extension lifecycle**: `src/extension.ts` boots localization (`localizeInit`) + status bar (`statusBarItemInit`), then hands off to `src/init.ts`, which iterates `moduleList` to load features. Every module must tolerate repeated `init` calls triggered by workspace/config events.
- **Folder structure**: `command/` (one-shot command handlers), `module/` (long-lived services + webviews/tree providers), `listener/` (file watchers using `node-watch`), `CustomTextEditorProvider/` (custom editors: Lazyboy launcher, KV editor, Behavior Tree editor), `utils/` (shared helpers), `TreeDataProvider/` (tree views), `Class/` (core services like `EventManager`, `FeiShu`).
- **Static resources**: `resource/` contains Lua/JS/CSS API dumps (JSON), localization templates, items/abilities text files. `images/` holds icons (spellicons, items, heroes). Modules like `module/treeApi.ts` and webviews consume these directly—no external API calls.
- **VS Code integration**: `package.json` contributes 3 activity-bar containers (`dota2api`, `dota2kv`, `dota2logs`), ~100+ commands, and 3 custom editors (Lazyboy, KV, Behavior Tree). Always keep `package.json` contributions in sync with implementation modules.
- **Workspace assumptions**: Extension targets Dota 2 addon workspaces. `module/addonInfo.ts` auto-discovers `game`/`content` folders by searching for `addoninfo.txt` via `findFile`, falling back to manual config `dota2-tools.addon_path` if auto-detection fails. **Critical**: users must keep actual maps under `maps/` folder for discovery to work.

## Critical Workflows
- **Dev build**: `npm run watch` (Task `npm: 0`) runs webpack in watch mode, compiling `src/**/*.ts` → `dist/extension.js`. Use this for live development.
- **Production build**: `npm run compile` produces optimized webpack bundle before publishing to marketplace.
- **Tests**: `npm run watch-tests` (Task `npm: 1`) runs `tsc -w` for type checking only—no runtime test framework. Type errors are your feedback.
- **Debug feedback**: All long-running operations (Feishu sync, Excel export, file parsing) must call `showStatusBarMessage(text, timeout)` or `refreshStatusBarMessage(index, text)` from `module/statusBar.ts` for user-visible progress. Messages appear in status bar + tooltip + output channel.
- **Webview loading**: HTML files live in `webview/<name>/<name>.html` (note: separate from `src/webview/`). Use `getWebViewContent(webview, extensionUri, webviewName)` from `utils/getWebViewContent.ts` to load and transform URIs for VS Code's CSP. Never use raw `fs.readFileSync` for webview resources.

## Conventions & Patterns
- **Event bus**: `EventManager` (`Class/event.ts`) centralizes VS Code events (`onDidChangeConfiguration`, `onDidChangeWorkspaceFolders`). Modules listen via `EventManager.listenToEvent<EventType>(type, callback)` instead of registering duplicate listeners. Returns event ID for cleanup via `stopListenToEvent`.
- **Module toggles**: User can disable modules via `dota2-tools.A1.module_list` config. `skipModuleList` in `src/init.ts` maps module init functions to config keys. When adding new modules: (1) add to `moduleList`, (2) add to `skipModuleList` if user-toggleable, (3) add config key to `package.json`.
- **Localization**: All user-facing strings use `localize(key)` from `utils/localize.ts`. Strings defined in `package.nls.json` (English) and `package.nls.zh-cn.json` (Chinese). Module names in `package.nls*.json` must match function names (e.g., `"luaApiInit": "lua tree document"`).
- **Path handling**: Always get addon roots via `getGameDir()`/`getContentDir()` from `module/addonInfo.ts`. Use helpers from `utils/pathUtils.ts` (`getPathInfo`, `makeDir`, `dirExists`) for async filesystem checks—these handle errors gracefully. Never assume paths exist.
- **KV parsing**: `utils/kvUtils.ts` provides `readKeyValue2(kvtext)` (parses Dota KV → JS object) and `writeKeyValue(obj, depth)` (JS object → KV text). Used extensively for abilities, units, localization files. Handle nesting and `#base` includes via `readKeyValueWithBase`.
- **CSV workflows**: `utils/csvUtils.ts` (`abilityCSV2KV`, `unitCSV2KV`) transforms Excel-exported CSVs → KV files. `listener/listenerAbilityExcel.ts` + `listenerUnitExcel.ts` watch CSV folders using `node-watch`, auto-regenerate KV on change. Controlled by `dota2-tools.A3.listener` and `A4.AbilityExcel`/`A4.UnitExcel` configs.
- **Localization merging**: `listener/listenerLocalization.ts` watches `game/resource/localization/<lang>/` folders, auto-merges all `.txt` files into `addon_<lang>.txt`. Output naming is hardcoded—don't create custom merge logic.

## Key Modules & Services
- **Feishu integration** (`module/sheet_cloud.ts` + `Class/FeiShu.ts`): Syncs cloud spreadsheets from Feishu (Lark). Caches tenant access tokens, sheet IDs. Commands: `dota2tools.fetch_all_sheet`, `dota2tools.sheet_cloud_show_branch`. Uses timers (`setInterval`) for polling—clean them up in disposal. Config: `dota2-tools.A8.FeiShu` (App ID/Secret, Branch Folder, per-language sheet IDs).
- **API explorers** (`module/treeApi.ts`, `TreeDataProvider/*ApiProvider.ts`): Builds tree views for Lua/JS/CSS/Panel APIs. Data sourced from static JSONs in `resource/` (e.g., `dota_script_help2.json`, `cl_panorama_script_help_2.json`). Each tree provider expects localized labels via `localize(<moduleName>)`.
- **Custom editors**:
  - `CustomTextEditorProvider/kvEditorProvider.ts` + `module/kvEditor.ts`: Full-featured KV editor with table view, registered for `.kv` and `.txt` files (priority: option). 
  - `CustomTextEditorProvider/behaviorTreeProvider.ts`: Visual behavior tree editor for `.tree` files (priority: default).
  - `CustomTextEditorProvider/lazayboyProvider.ts`: Launches external app (e.g., Lazyboy model viewer) via `exec`, then disposes webview.
- **Error logs** (`module/errorLogs.ts`, `TreeDataProvider/ErrorLogProvider.ts`): Parses Dota 2 error logs from user-configured directories, displays in `dota2Logs` tree view. Config: `dota2-tools.A9.logs`.
- **Status bar** (`module/statusBar.ts`): Owns global status items + output channel. Use `getStatusBarItem()` for main item, `showStatusBarMessage(text, timeout)` for temporary messages. Tooltip shows last 20 messages as Markdown.
- **Asset pickers** (`command/cmdDota2IconPanel.ts`, `cmdVsndPicker.ts`, `module/dota2itemsGame.ts`): Shared pattern—prepare data in module (e.g., index icons from `images/spellicons`), render picker in webview HTML (`webview/dota2Icon/`), communicate via `postMessage`. Users click to copy paths.

## Integration Notes
- **Feishu setup**: Requires config at `dota2-tools.A8.FeiShu`: `app_id`, `app_secret`, `branch_folder`, per-language sheet IDs (`schinese_id`, `english_id`). `Class/FeiShu` refreshes tenant tokens automatically (2h expiry); always call `await updateTenantAccessToken()` before API requests.
- **Excel → KV pipeline**: Users edit Excel workbooks, which auto-export to `csv/` subfolders (via Excel macros). Extension watches CSVs, converts to KV. Entry point: `command/cmdExcel2KV.ts`'s `eachExcelConfig(config, callback)` iterator. New CSV features should hook into this instead of duplicating traversal.
- **Localization I/O**: Commands in `command/cmdLocalization.ts` (`localizationBackup`, `localizationImportTool`, `localizationCompare`) expect Dota KV `lang` blocks. Always use `readKeyValue2`/`writeKeyValue` from `kvUtils` for parsing.
- **Performance note**: Many modules use synchronous `fs.readFileSync` on large resource files (APIs, items_game.txt). Keep heavy ops out of `activate()` function—lazy-load in module `init` functions to avoid blocking extension startup.
- **Webview HTML location**: Webview HTML files live in `webview/<name>/` folder (peer to `src/`), NOT `src/webview/`. TypeScript for webviews can be in `src/webview/` for bundling, but HTML/CSS must be in `webview/` for `getWebViewContent` to resolve paths correctly.



