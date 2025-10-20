# VS Code Dota2 Tools – Copilot Instructions

## Big Picture
- `src/extension.ts` localizes, builds the status bar/output channel, runs `init(...)`, then instantiates `FeiShu`; expect re-entry because workspace-folder changes trigger `init` again.
- `src/init.ts` enumerates `moduleList`; each `*Init` must be idempotent and honour `skipModuleList` flags from `dota2-tools.A1.module_list`, using `showStatusBarMessage`/`refreshStatusBarMessage` for progress logging.
- Core services live in `src/module/`; command implementations sit in `src/command/` with matching `*Init` helpers registered via `init.ts`. Tree providers reside under `src/TreeDataProvider/`, completions under `src/Completions/`, custom editors under `src/CustomTextEditorProvider/`.
- `src/utils/` centralizes plumbing (`getPathConfiguration`, `writeKeyValue`, `abilityCSV2KV`, `unitCSV2KV`, `getWebviewContent`); reuse them instead of adding bespoke copies.
- Heavy singletons (`getLuaApiTree`, `getLuaCompletion`, `getDotaApiNoteClass`, `FeiShu`) cache state—always access through their exported getters.

## Module Lifecycle & Config
- Use `EventManager` (`Class/event.ts`) instead of raw VS Code subscriptions; listeners must early-return unless `event.affectsConfiguration(...)` covers the relevant namespace.
- Watchers in `src/listener/` (Excel, localization, KV→JS) hinge on `dota2-tools.A3.listener`; invoke their `stopWatch()` before restarting to avoid duplicate `node-watch` handles.
- File-path settings accept `${game}`, `${content}`, `${workspace}` placeholders; resolve them with `getPathConfiguration` or `eachExcelConfig` rather than manual concatenation.
- `addonInfoInit` caches Game/Content directories via `findFile('addoninfo.txt')` and `dota2-tools.addon_path`; always fetch `getGameDir`/`getContentDir` before filesystem work.
- The KV editor (`module/kvEditor.ts`) hooks configuration changes through `dota2-tools.A10.kv_editor`; use `readKvEditorSettings`/`updateSettings` to keep the tree and custom editor in sync.

## Data Sources & Sync
- `Class/DotaApiNote` loads `resource/api_note*.json` (plus remote data) and drives tree/completion refreshes; call the provided callbacks after mutating note data so caches stay coherent.
- Excel→KV flows use `cmdExcel2KV` and `abilityCSV2KV`/`unitCSV2KV`; reuse `eachExcelConfig` so `${game}` substitution, directory validation, and status logging remain consistent.
- Localization merges rely on `getPathConfiguration('dota2-tools.A5.localization_path')` and trigger `combineLocalization(language)` per folder; align new automation with that structure.
- `module/sheet_cloud.ts` polls Feishu every 5 s; extend via `processFileData`/`exportSheetToCsv`, update `syncList`, and honour branch settings under `dota2-tools.A8.*`.
- `resource/` assets feed completions, explorers, and webviews; after changing them, rerun the relevant init (`apiNoteInit`, `cssApiInit`, etc.) or expose a refresh command.

## UI Patterns
- Status updates go through `showStatusBarMessage`; it also appends to the shared output channel toggled by `dota2tools.showOutput`. Switch the icon with `changeStatusBarState(StatusBarState.LOADING|ALL_DONE)`.
- Webviews obtain HTML via `utils/getWebviewContent`, which injects toolkit/codicon assets and rewrites relative URIs; keep feature assets under `webview/<feature>/` so the rewrite logic holds.
- Tree providers (`ApiTreeProvider`, `ErrorLogTreeProvider`, `KvEditorTreeProvider`) expose `refresh*` helpers—call them instead of rebuilding providers to preserve expansion state.
- Custom editors register through their `register(context)` exports (e.g., `kvEditorProvider.register`); let `kvEditorInit` manage lifecycle so explorers and editors stay aligned.

## Workflows & Tooling
- Install deps with `npm install`; run `npm run watch` (or VS Code task `npm: watch`) for incremental webpack builds, `npm run watch-tests` for the test bundle, and `npm run compile` for production output in `dist/extension.js`.
- Release builds go through `node publish_patch.js`, which wraps `vsce publish patch`; ensure `vsce` is installed and versioning rules are satisfied.
- Feishu integrations require valid credentials under `dota2-tools.A8.FeiShu`; route all REST calls through `FeiShu.request` to reuse token refresh logic.

## Conventions & Gotchas
- Route user-facing strings through `localize(...)` / `reverseLocalize` and add keys to `package.nls*.json`.
- Extend shared typings in `src/declarations/common.d.ts` when introducing new config shapes; missing declarations break `tsc`.
- Use `writeKeyValue` (`src/utils/kvUtils`) and CSV helpers for KV serialization so `AbilitySpecial`/`AbilityValues` stay compliant.
- Dispose timers, watchers, or intervals (or guard with singletons) to keep repeated `init` calls safe.
