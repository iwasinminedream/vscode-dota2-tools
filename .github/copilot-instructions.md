# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- `src/extension.ts` boots localization (`localizeInit`), status bar, `init(...)`, and a `FeiShu` instance before registering all `dota2tools.*` commands—treat every module init as idempotent.
- `src/init.ts` walks `moduleList`; each `*Init` skips when `dota2-tools.A1.module_list` disables it and reports progress through `showStatusBarMessage`/`refreshStatusBarMessage`.
- Core services sit under `src/module/` (API notes, completions, sheets, logs, translate, KV editor) while command handlers live in `src/command/` and reuse shared helpers.
- `src/utils/` hosts plumbing (`getPathConfiguration`, `writeKeyValue`, `abilityCSV2KV`, `unitCSV2KV`, `getWebviewContent`); prefer these over ad-hoc copies.
- Singletons (`getLuaApiTree`, `getLuaCompletion`, `FeiShu`, etc.) cache heavy state—retrieve via accessors instead of re-instantiating.

## Module Lifecycle & Config
- `moduleList` uses `skipModuleList` + `ModuleListConfig` keys; check `dota2-tools.A1.module_list` or call `isSkipModule` patterns when adding new toggles.
- Settings changes flow through `EventManager` (`Class/event.ts`); listeners should early-return unless `event.affectsConfiguration(...)` matches the module’s namespace.
- Watchers like `listenerAbilityExcelInit` and `listenerKV2JSInit` read `dota2-tools.A3.listener`; always call their exposed `stopWatch()` before restarting to avoid duplicate `node-watch` handles.
- Translation, sheet cloud, and other services read bespoke config blocks (`dota2-tools.A7.*`, `A8.*`, `A10.*`); respect existing quick-pick UX and `localize(...)` labels when extending options.
- `addonInfoInit` auto-detects `game`/`content` via `findFile('addoninfo.txt')`, storing paths for path helpers—new code should consult `getGameDir`/`getContentDir` before touching the file system.

## Data Sources & Sync
- `Class/DotaApiNote.ts` seeds from `resource/api_note.json` plus MySQL (see `action(...)`); `apiNote.init` refreshes Lua trees and completion providers, so trigger those callbacks after mutating note data.
- Feishu/Lark automation in `module/sheet_cloud.ts` polls every 5 s, manages branch quick-picks, and converts spreadsheets using `processFileData` + `abilityCSV2KV`/`unitCSV2KV`; keep exports in sync with status bar indicators.
- Excel → KV workflows go through `cmdExcel2KV` and `eachExcelConfig`, expanding `${game}`/`${content}` placeholders with `getPathConfiguration`/`addonInfo`; reuse these utilities for any new CSV pipelines.
- Localization and translation modules cascade their updates through `translateInit`, `localization` commands, and `dota2-tools.A7` settings—ensure new integrations honour the configured provider.
- Resource caches under `resource/` feed completions, webviews, and viewers; after editing them, trigger the appropriate module refresh (e.g., re-run `apiNoteInit`, reload trees, or rerun watchers) so UI stays consistent.

## UI Patterns
- Tree providers in `src/TreeDataProvider/` pair with `statusBar` history; when mutating tree data, append messages via `showStatusBarMessage` to keep tooltips meaningful.
- Webviews load via `utils/getWebViewContent`, which injects shared assets from `webview/common`; keep new feature assets under `webview/<feature>/` so URI rewriting succeeds.
- Custom editors like `CustomTextEditorProvider/kvEditorProvider.ts` register through `kvEditorInit`; ensure new editors follow the `register(context)` pattern and expose commands via `TreeDataProvider` or `vscode.openWith`.
- The KV explorer (`module/kvEditor.ts`) wires settings watchers to `EventManager`; use `readKvEditorSettings` + `updateSettings` to stay aligned with UI filters.

## Workflows & Tooling
- Install dependencies with `npm install`; use `npm run watch` or the `npm: watch` VS Code task for webpack builds, and `npm run watch-tests` for test-mode bundling.
- Production bundles land in `dist/extension.js` via `npm run compile`; ensure new entry points are declared in `webpack.config.js` or marked external.
- Publishing runs `node publish_patch.js` (wraps `vsce publish patch`); verify `vsce` exists and version bump rules are met before invoking.
- Feishu dev relies on `@larksuiteoapi/node-sdk` + axios-based `utils/request`; new integrations should reuse `FeiShu.request` to inherit token refresh logic.

## Conventions & Gotchas
- Always route user-facing strings through `localize(...)`/`reverseLocalize` (`src/utils/localize.ts`), keeping keys in `package.nls*.json`.
- Extend shared types (`Table`, `LuaFunction`, `ModuleListConfig`, etc.) in `src/declarations/common.d.ts`; missing typings here break the TS build.
- Prefer `getPathConfiguration` when dealing with `${game}`/`${content}`/`${workspace}` placeholders, and avoid manual string concatenation.
- Long tasks should toggle `changeStatusBarState(StatusBarState.LOADING/ALL_DONE)` and emit progress via `showStatusBarMessage`; history drives both status bar text and the output channel.
- When adding watchers or timers, honour existing intervals and dispose handles on deactivate; leaking timers keeps the extension hot and duplicates work.
