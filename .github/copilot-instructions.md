# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- `src/extension.ts` localizes, builds status/output UI, runs `init(...)`, then instantiates the FeiShu client; `init` re-runs on workspace-folder changes so every module init must be idempotent.
- `src/init.ts` enumerates `moduleList`; each `*Init` registers commands/providers quickly and honours `dota2-tools.A1.module_list` plus status bar progress via `showStatusBarMessage` and `refreshStatusBarMessage`.
- Responsibilities split across directories: `module/` (long-lived services), `command/` (command bodies), `TreeDataProvider/` + `CustomTextEditorProvider/` (views/editors), `listener/` (watchers), and `utils/` (shared plumbing).
- Runtime data ships in `resource/`, `kv/`, and `webview/`; API browsers, completions, and icon pickers read these JSON/TXT assets at startup.

## Lifecycle & Configuration
- Reuse exported singletons (`getLuaApiTree`, `getDotaApiNoteClass`, `FeiShu`, etc.) and trigger their refresh callbacks after mutating cached data.
- Event handling flows through `Class/event.ts`; register via `EventManager.listenToEvent` and bail unless `event.affectsConfiguration(...)` matches your namespace.
- Path settings allow `${game}`, `${content}`, `${workspace}`—resolve with helpers (`getPathConfiguration`, `eachExcelConfig`, `getRootPath`) instead of manual string math.
- `module/addonInfo.ts` discovers Dota directories (config or `addoninfo.txt` search); consult `getGameDir()` / `getContentDir()` before touching disk.

## Watchers & Automation
- Watchers live under `listener/` (Excel→KV, KV→JS, localization). Always `stopWatch()` before re-registering and respect `dota2-tools.A3.listener` toggles.
- Excel→KV runs via `eachExcelConfig`, `abilityCSV2KV` / `unitCSV2KV`, and `writeKeyValue`; keep AbilitySpecial handling consistent when extending the pipeline.
- Localization merge uses `combineLocalization` plus watcher events; reuse the same helpers so `${language}` folder schemes stay valid.

## UI Surfaces
- Status updates route through `module/statusBar.ts`; use its helpers so output channel logging and icons (`changeStatusBarState`) stay coordinated.
- Webviews must load HTML through `utils/getWebviewContent` to rewrite URIs and inject toolkit assets; stash feature bundles under `webview/<feature>/`.
- KV tooling links the tree (`TreeDataProvider/kvTree.ts`) with the custom editor (`CustomTextEditorProvider/kvEditorProvider.ts`); read settings via `readKvEditorSettings` and update through the provider rather than ad-hoc reads.

## External Integrations
- Feishu sync (`Class/FeiShu.ts`, `module/sheet_cloud.ts`) centralizes auth and rate limiting; route all remote calls through `FeiShu.request` so tenant tokens refresh automatically.
- API note data (`module/apiNote.ts`, `Class/DotaApiNote`) feeds trees and completions; after edits, invoke the provided update hooks to refresh caches.

## Conventions & Gotchas
- Localize UI strings with `localize(...)` / `reverseLocalize` and add entries to `package.nls*.json`; new config shapes belong in `src/declarations/common.d.ts` to keep `tsc` happy.
- `init` can run repeatedly—guard timers, intervals, and watchers with module-level flags or proper disposal to prevent leaks.
- Prefer shared helpers (`utils/getWebviewContent`, `utils/kvUtils`, `utils/pathUtils`) over bespoke logic to stay aligned with existing behaviour.

## Workflows
- Install deps once with `npm install`; incremental builds use `npm run watch` (task `npm: watch`), and production bundles come from `npm run compile` to `dist/extension.js`.
- Test/watch support lives in `npm run watch-tests`; there is no dedicated unit suite, so rely on type checks plus manual validation of key commands.
- Publishing uses `node publish_patch.js`, wrapping `vsce publish patch`; confirm VSCE availability and version bumps before running it.
