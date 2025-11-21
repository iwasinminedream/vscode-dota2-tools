# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- `src/extension.ts` boots localization + status bar, then hands off to `src/init.ts`, which iterates `moduleList`; every module must tolerate repeated `init` calls triggered by workspace or config events.
- Feature areas are split by folder: `command/` (command handlers), `module/` (long-lived services + webviews/tree providers), `listener/` (file watchers), `CustomTextEditorProvider/` (Lazyboy + KV editors), `utils/` (shared helpers).
- Gameplay data lives under `resource/` (Lua/JS API dumps, localization templates, items/abilities text) and `images/`; modules such as `module/treeApi.ts` or `webview/` consume these files directly instead of hitting external services.
- `package.json` contributes activity-bar containers (`dota2api`, `dota2kv`, `dota2logs`), dozens of commands, and custom editors—keep contributions in sync with implementation modules.
- The extension assumes a Dota Addon workspace: `module/addonInfo.ts` auto-discovers `game`/`content` folders via `findFile`, falling back to `dota2-tools.addon_path` if discovery fails (see README guidance about keeping actual maps under `maps/`).

## Critical Workflows
- Dev loop: `npm run watch` (Task `npm: 0`) runs webpack in watch mode against `src/` -> `dist/extension.js`; `npm run compile` produces a prod bundle before publishing.
- Tests: `npm run watch-tests` (Task `npm: 1`) simply runs `tsc -w`; failures surface as type errors rather than runtime specs.
- Status/debug feedback is surfaced via `showStatusBarMessage`/`refreshStatusBarMessage` in `module/statusBar.ts`; long operations (e.g., Feishu sync, Excel export) should always emit progress here.
- Webviews live under `src/webview/**` and load HTML through `utils/getWebViewContent.ts` to rewrite URIs—never inline `fs.readFileSync` in modules or resource loading will break under VS Code’s CSP.

## Conventions & Patterns
- Central event bus: `EventManager` (`Class/event.ts`) fans out configuration/workspace changes; long-running services listen via `EventManager.listenToEvent` instead of registering duplicate VS Code listeners.
- Module toggles come from `dota2-tools.A1.module_list`; `skipModuleList` in `src/init.ts` keeps config keys aligned—when adding modules, wire them here so users can disable them.
- Use `localize(key)` from `utils/localize.ts`, with strings stored in `package.nls*.json`. New modules need `localizeInit` to run before they read strings.
- Path handling: grab addon roots via `getGameDir()/getContentDir()` from `module/addonInfo.ts`, and rely on `utils/pathUtils.ts` (`getPathInfo`, `makeDir`, `dirExists`) before touching the filesystem.
- KV/CSV transforms: `utils/kvUtils.ts` (`readKeyValue2`, `writeKeyValue`) and `utils/csvUtils.ts` drive Excel workflows; `listener/listenerAbilityExcel.ts` + `listenerUnitExcel.ts` watch CSV mirrors using `node-watch` and honor config `dota2-tools.A3.listener` & `A4.*` settings.
- Localization merge: `listener/listenerLocalization.ts` merges per-language files under `resource/localization`; output naming is fixed (`addon_<lang>.txt`), so reuse the helper rather than touching `fs` directly.

## Key Modules & Services
- `module/sheet_cloud.ts` talks to Feishu via `Class/FeiShu.ts`; it caches sheet tokens, exposes commands like `dota2tools.fetch_all_sheet`, drives two status-bar items, and persists branch info via configs `dota2-tools.A8.*`. Respect its timers (`setInterval`) and clean them up when adding new workflows.
- `module/treeApi.ts` builds the API/JS/CSS/Panel explorers registered in `TreeDataProvider/`; they read static JSON dumps from `resource/` and expect localized labels (`localize(<moduleName>)`).
- `module/kvEditor.ts` + `CustomTextEditorProvider/kveditor` implement the KV custom editor surfaced via `package.json`. Use their helpers instead of rolling new document providers.
- `module/errorLogs.ts` feeds the `%dota2Logs.title%` view using `TreeDataProvider/ErrorLogProvider`; data sources are parsed log files under user-configured directories.
- `module/statusBar.ts` owns all global status items; request handles via `getStatusBarItem()` instead of instantiating new bars directly.
- Asset/UI pickers (`command/cmdDota2IconPanel.ts`, `cmdVsndPicker.ts`, `module/dota2itemsGame.ts`, `webview/dota2Icon/`) share a pattern: prepare data in `module/`, render via HTML from `webview/**`, and use messages typed in `src/webview/*.ts`.

## Integration Notes
- Feishu access requires `dota2-tools.A8.FeiShu` config (App ID/Secret, Branch Folder, per-language IDs). `Class/FeiShu` refreshes tenant tokens automatically; always call `updateTenantAccessToken` before hitting Lark endpoints.
- CSV/Excel automation expects each workbook to emit `csv/` siblings (see README). `command/cmdExcel2KV.ts` orchestrates `eachExcelConfig`, so new CSV-driven features should hook in there instead of duplicating traversal logic.
- Localization backup/import commands live in `command/cmdLocalization.ts` and expect text files shaped like Dota KV `lang` blocks; reuse `kvUtils` helpers when expanding them.
- Many modules assume synchronous file IO (`fs.readFileSync`) against large resource blobs; keep operations off activation if they can be lazily loaded to avoid blocking startup.



