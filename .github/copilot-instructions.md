# VS Code Dota2 Tools – Copilot Instructions (repository-specific)

## Big picture (what initializes what)
- `src/extension.ts` is the entry: it builds the status bar & output channel, calls `init(...)`, then creates the `FeiShu` service. `init` can be re-run (watch workspace-folder changes) so all module inits must be idempotent.
- `src/init.ts` owns the module list and lifecycle. Each module exposes a `*Init` that should register commands/providers and return fast; they must obey `dota2-tools.A1.module_list` and call `showStatusBarMessage`/`refreshStatusBarMessage` for progress.
- Code is organized by responsibility: `src/module/` (services & lifecycle), `src/command/` (command handlers), `src/TreeDataProvider/` (trees), `src/Completions/` (language completions), `src/CustomTextEditorProvider/` (custom editors), and `src/utils/` (shared helpers).

## Important patterns & conventions
- Singletons: use exported getters (e.g. `getLuaApiTree`, `getLuaCompletion`, `getDotaApiNoteClass`, `FeiShu`) — they cache state and must be refreshed via their provided callbacks after mutations.
- Event handling: prefer `EventManager` in `src/Class/event.ts` instead of raw VS Code subscriptions. Listeners should early-return unless `event.affectsConfiguration(...)` matches the namespace.
- Watchers: file watchers live under `src/listener/`. Respect `dota2-tools.A3.listener` and always call `stopWatch()` before restarting to avoid duplicate `node-watch` handles.
- Path resolution: settings support placeholders (`${game}`, `${content}`, `${workspace}`); use `getPathConfiguration` or helpers like `eachExcelConfig` to resolve them correctly.
- Webviews: always use `utils/getWebviewContent` to load HTML (it rewrites URIs and injects assets). Place webview assets under `webview/<feature>/`.

## Data flows & integration points
- Dota API notes: `Class/DotaApiNote` loads `resource/api_note*.json` (and remote/data downloaded in `api_note_download.json`) and drives completions & tree providers. After mutating note data, call the class callbacks so dependent caches update.
- Excel → KV: commands like `cmdExcel2KV` and helpers `abilityCSV2KV` / `unitCSV2KV` handle CSV → KV conversion. Use `eachExcelConfig` to apply folder substitutions and validation.
- Localization: use `getPathConfiguration('dota2-tools.A5.localization_path')` and run `combineLocalization(language)` per folder. The localization pipeline expects the repo's folder layout.
- Feishu / cloud sheet: `module/sheet_cloud.ts` polls Feishu (default 5s). Route requests through `FeiShu.request` to reuse token refresh and error handling.

## Quick developer workflows
- Install deps: `npm install`.
- Development build/watch: `npm run watch` (also available as VS Code task `npm: watch`).
- Tests (watch): `npm run watch-tests` (VS Code task `npm: watch-tests`).
- Production compile: `npm run compile` → produces `dist/extension.js`.
- Release/patch: `node publish_patch.js` (wraps `vsce publish patch`). Ensure `vsce` is installed and `package.json` version rules satisfied.

## Files and places to check when changing behavior
- Module lifecycle and startup: `src/init.ts`, `src/extension.ts`.
- Command implementations: `src/command/` and their `*Init` registration in `init.ts`.
- Shared helpers: `src/utils/` (notable: `getPathConfiguration`, `getWebviewContent`, `writeKeyValue`, CSV → KV helpers).
- Trees & providers: `src/TreeDataProvider/`, `src/Completions/`, `src/CustomTextEditorProvider/`.
- Resources driving content: `resource/` (api notes, items, abilities), `webview/` (static webview assets), and `kv/` (abilities/units).

## Code-style & pitfalls discovered in repo
- String localization: always use `localize(...)` / `reverseLocalize` and add keys to `package.nls*.json`.
- TypeScript declarations: extend `src/declarations/common.d.ts` for new config shapes — missing declarations break `tsc`.
- KV serialization: use `writeKeyValue` and CSV helpers to produce valid KV (special cases for `AbilitySpecial` / `AbilityValues`).
- Resource edits: when changing files under `resource/` or `webview/`, rerun the appropriate init (for example `apiNoteInit` or `cssApiInit`) or provide a refresh command so runtime caches pick up changes.

## Small examples (where to look)
- Module init pattern: see `src/init.ts` and any `*Init` in `src/module/` (they call `context.subscriptions.push(...)` and use `showStatusBarMessage`).
- Webview loading: `webview/common/getWebviewContent` (rewrites resource URIs and injects assets).
- Feishu usage: `src/module/sheet_cloud.ts` and `src/Class/FeiShu` (use `FeiShu.request(...)`).

## When you change things — checklist for a PR
- Update/add `package.nls*.json` keys for new UI strings.
- Update `src/declarations/common.d.ts` for new setting shapes.
- If you added resources under `resource/` or `webview/`, call the relevant init or add a refresh command so runtime caches pick up changes.
- Run `npm run watch` (or compile) and run the tests/watchers to ensure no type/runtime regressions.

If any section is unclear or you want me to expand examples (init functions, typical command implementation, or the FeiShu flow), tell me which area and I will iterate.
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
