# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- This extension surfaces Dota2 authoring utilities built on VS Code APIs; TypeScript entry `src/extension.ts` localizes UI, spins status bar, calls `init(...)`, wires ~30 commands, then instantiates the global `FeiShu` client.
- `src/init.ts` iterates `moduleList` and re-runs on workspace/config changes; each module init must be idempotent because settings toggles or folder changes trigger it again.
- Responsibilities by folder: `module/` long-lived singletons (status bar, API notes, sheet cloud), `command/` command bodies, `listener/` file watchers, `TreeDataProvider/` & `CustomTextEditorProvider/` for views/editors, `utils/` for shared helpers.
- Runtime data under `resource/`, `kv/`, and `webview/` feed API browsers, completions, and icon pickers; never mutate them without refreshing dependent caches.

## Initialization Flow
- `moduleListConfig` in `dota2-tools.A1.module_list` decides which inits run; `skipModuleList` maps module names to config keys, so respect these checks when adding modules.
- Use `showStatusBarMessage` / `refreshStatusBarMessage` during init to keep progress output consistent; status text also mirrors to the dedicated output channel opened via `dota2tools.showOutput`.
- Subscribe to `EventManager` (`Class/event.ts`) instead of raw VS Code listeners so module reconfiguration stays centralized.
- If a module needs cleanup, export a `stop...` helper and call it before re-registering because `init` runs again on workspace-folder changes.

## Runtime Data & State
- `module/addonInfo.ts` discovers `${game}` and `${content}` paths via settings or `addoninfo.txt`; query `getGameDir()` / `getContentDir()` before touching disk.
- Path settings accept tokens (`${game}`, `${content}`, `${workspace}`); resolve with helpers like `getPathConfiguration`, `eachExcelConfig`, and `getRootPath`.
- API note data (`resource/api_note*.json`) flows through `Class/DotaApiNote`; after edits call refresh callbacks so trees and completions update.
- Localization strings live in `package.nls*.json`; add new keys via `localize`/`reverseLocalize` and update `src/declarations/common.d.ts` when setting schemas change.

## Automation & Watchers
- Excel→KV (`listenerAbilityExcel.ts`, `listenerUnitExcel.ts`) and KV→JS (`listenerKV2JS.ts`) watchers respect `dota2-tools.A3.listener`; always `stopWatch()` before re-registering on config change.
- CSV conversion relies on `command/cmdExcel2KV` helpers (`eachExcelConfig`, `abilityCSV2KV`, `unitCSV2KV`, `writeKeyValue`); maintain AbilitySpecial numbering logic if extending.
- Localization merge uses `listenerLocalization.ts` plus `command/cmdLocalization.ts`; keep new automation aligned with `combineLocalization`.
- `node-watch` instances operate under `getRootPath()`; guard against missing workspace folders and surface issues through status bar messages instead of raw errors.

## UI & Interaction
- Status bar state centralizes in `module/statusBar.ts`; use `showStatusBarMessage`, `refreshStatusBarMessage`, and `changeStatusBarState` instead of mutating UI directly.
- API trees (`TreeDataProvider/*`) link to completions via `getLuaApiTree()` and `getDotaApiNoteClass()`; call their refresh methods rather than rebuilding providers.
- Webviews must load HTML with `utils/getWebviewContent` so resource URIs rewrite correctly; stash feature assets under `webview/<feature>/`.
- KV tooling couples `TreeDataProvider/kvTree.ts` and `CustomTextEditorProvider/kvEditorProvider.ts`; read editor prefs via `readKvEditorSettings` before writing back to disk.

## External Integrations
- `Class/FeiShu` encapsulates Lark API auth and throttling; route cloud sync through `FeiShu.request` so tenant tokens auto-refresh.
- `module/sheet_cloud.ts` manages timers, status badges, and quick picks for branch-aware sheet sync; reuse helpers like `processFileData`, `exportSheetToCsv`, and `switchBranch` to stay within existing polling logic.
- When touching cloud sync, keep `sheetIDMap`, `branchList`, and `exportTaskList` caches current—they suppress redundant API calls and drive polling intervals.

## Build & Validation
- Install deps with `npm install`; hot reload TypeScript via `npm run watch` (task `npm: 0`), build release bundles with `npm run compile`, and exercise incremental checks with `npm run watch-tests`.
- Webpack outputs to `dist/extension.js`; adjust shared globals with `webpack.config.js` in mind when pulling new dependencies.
- There is no dedicated automated suite beyond watch-tests; lean on type checking plus manual validation of core commands and webviews.

## Conventions & Pitfalls
- Keep modules idempotent and store disposables in `context.subscriptions`; expose memoized accessors (`getLuaCompletion`, `getDotaApiNoteClass`) when sharing state.
- Settings toggles live under namespaced keys (`dota2-tools.A*`); add new ones to `package.json`, `package.nls*.json`, and `src/declarations/common.d.ts` together.
- Many commands assume valid `${game}`/`${content}` directories; call `isValidFolder()` and report actionable status messages when paths are missing.
- Prefer shared helpers (`utils/kvUtils`, `utils/pathUtils`, `utils/getWebviewContent`) over bespoke logic to stay aligned with existing workflows.
