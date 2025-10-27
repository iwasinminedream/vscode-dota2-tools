# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- **Extension entry** `src/extension.ts` localizes strings, spins up the status bar, runs `init(context)`, registers ~30 `dota2tools.*` commands, then instantiates the global `FeiShu` client for sheet sync.
- **Module loader** `src/init.ts` loops `moduleList` and respects user config `dota2-tools.A1.module_list`; expect modules to re-run whenever workspace folders or config change.
- **Folder roles**: `command/` command bodies, `module/` long-lived services, `listener/` fs watchers, `TreeDataProvider/` & `CustomTextEditorProvider/` VS Code views/editors, `utils/` shared helpers, `resource/` + `kv/` + `webview/` static datasets consumed by UI.
- **Domain**: This extension automates Dota 2 custom game development workflows—Excel↔KV conversion, API documentation browsing, icon/asset pickers, localization merging, and cloud sheet syncing via Feishu/Lark.

## Module Lifecycle
- **Extending modules**: Add to `moduleList` in `init.ts` only with idempotent initializers; map feature toggles in `skipModuleList` and surface new keys through `package.json` + `package.nls*.json` + `src/declarations/common.d.ts`.
- **Event handling**: Use `EventManager` (`Class/event.ts`) instead of raw VS Code listeners to hook configuration/workspace events and store the listener index for cleanup—call `EventManager.listenToEvent(EventType.EVENT_ON_DID_CHANGE_CONFIGURATION, callback)` and save the returned index.
- **Status bar**: `module/statusBar.ts` centralizes progress + logging; call `showStatusBarMessage(text, timeout?)` / `refreshStatusBarMessage(index, text)` (and `changeStatusBarState(StatusBarState.LOADING)`) rather than touching the item directly.
- **Graceful re-init**: Before re-registering disposables (watchers, providers) expose a `stop...` helper and invoke it; `init.ts` expects modules to handle repeated activation gracefully when workspace folders change.

## Paths, Data & Localization
- `module/addonInfo.ts` caches `${game}`/`${content}` paths via settings `dota2-tools.addon_path` or `addoninfo.txt`; always call `getGameDir()` / `getContentDir()` and check `isValidFolder()` before filesystem work.
- Helpers like `eachExcelConfig` and `getRootPath()` resolve `${game}`, `${content}`, `${workspace}` tokens before reading from disk; reuse them for new path-aware flows.
- API notes live under `resource/api_note*.json` and are loaded by `Class/DotaApiNote`; update downstream trees/completions through the callbacks in `apiNoteInit` when mutating note data.
- String resources live in `package.nls*.json`; use `localize`/`reverseLocalize` (`utils/localize.ts`) and update declaration types when adding settings or messages.

## Automation & Watchers
- CSV/Excel automation hangs off `listenerAbilityExcel.ts`, `listenerUnitExcel.ts`, and `listenerKV2JS.ts`; they watch `getRootPath()` recursively via `node-watch` and honor toggles in `dota2-tools.A3.listener`.
- `command/cmdExcel2KV.ts` drives conversions using `eachExcelConfig`, `abilityCSV2KV`/`unitCSV2KV`, and `writeKeyValue`; preserve AbilitySpecial numbering + dynamic extensions in `getExtname` when extending.
- Localization merge flows through `listener/listenerLocalization.ts` and `command/cmdLocalization.ts`; keep `combineLocalization` as the canonical merge entry point.
- Surface watcher state changes via the status bar (e.g. `[监听目录]` messages) to stay consistent with existing UX.

## UI, Views & Webviews
- Tree views and editors (KV explorer) live in `module/kvEditor.ts`, `TreeDataProvider/kvTree.ts`, `CustomTextEditorProvider/kvEditorProvider.ts`; call `readKvEditorSettings` to respect `dota2-tools.A10.kv_editor` before rendering.
- API browsers under `module/treeApi.ts` share data with completions (`module/completion.ts`); refresh using provided accessors (`getLuaApiTree`, `getLuaCompletion`) instead of re-creating providers.
- Webviews read HTML through `utils/getWebviewContent`; stash assets in `webview/<feature>/` and ensure URIs route via `asWebviewUri` inside the helper to avoid broken resources.

## External Integrations
- `Class/FeiShu` wraps Lark/Feishu REST + SDK; always call `FeiShu.request` to reuse token refresh and honor rate limits declared in `URL_LIST`.
- `module/sheet_cloud.ts` orchestrates sheet syncing (branch quick picks, timers, caches `sheetIDMap`/`branchList`/`exportTaskList`); reuse its helpers when extending cloud features.
- HTTP utilities (`utils/request.ts`) centralize fetch logic and should be reused for any new remote calls.

## Build & Validation
- Standard workflow: `npm install`, then `npm run watch` (task `npm: 0`) for type checking + incremental build; use `npm run compile` for production bundle (`dist/extension.js`).
- Incremental validation relies on `npm run watch-tests` (task `npm: 1`); no other automated tests exist, so manual verification of commands/webviews is expected.
- Webpack config (`webpack.config.js`) shares globals—adjust it when introducing new entry points or externals.

## Conventions & Pitfalls
- Register disposables on `context.subscriptions`; memoize singleton accessors (e.g. `getDotaApiNoteClass`, `getLuaCompletion`) for cross-module sharing.
- Many commands assume resolved addon directories; when paths are missing, use `showStatusBarMessage` plus friendly `vscode.window` prompts instead of throwing.
- Prefer helpers in `utils/` (`kvUtils`, `pathUtils`, `getWebviewContent`, `findFile`) over bespoke logic to stay aligned with existing error handling and token resolution.
- New commands must be registered in `extension.ts` and declared in `package.json` contributions + localization files to appear in the command palette.
- KV file parsing: `readKeyValue2` in `kvUtils.ts` handles both KV2 and KV3 formats with comment stripping; use `writeKeyValue` for consistent formatting when generating KV output.
- CSV parsing: `csvUtils.ts` provides `csv2obj` for both horizontal (default) and vertical layouts; ability tables expect double-row format (row 1 = ability metadata, row 2 = AbilitySpecial values).

