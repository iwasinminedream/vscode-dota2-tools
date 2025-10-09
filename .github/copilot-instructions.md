# VS Code Dota2 Tools – Copilot Instructions

## Orientation
- `src/extension.ts` is the entrypoint; it localizes strings, sets up the status bar, runs `init(...)`, then registers every command under the `dota2tools.*` namespace.
- `src/init.ts` orchestrates feature modules. Each module exports an `*Init` function and may be skipped by user settings under `dota2-tools.A1.module_list`; read those flags before auto-enabling new functionality.
- Shared helpers live under `src/utils/`; prefer `localize`, `getWebviewContent`, `writeKeyValue`, and `getPathConfiguration` instead of reinventing file/path handling or webview glue.
- Global duct-tape types (`Table`, `LuaFunction`, etc.) are declared in `src/declarations/common.d.ts`; keep additions there so strict TS stays happy.

## Data & External Systems
- API browsing, completion, and notes flow through `DotaApiNote` (`src/Class/DotaApiNote.ts`), which boots from `resource/api_note.json` and then synchronizes against a remote MySQL instance. Avoid blocking edits around `action(...)`; always refresh downstream caches via `apiNote.init` callbacks.
- Feishu/Lark cloud sync is centralized in `src/module/sheet_cloud.ts` using `FeiShu` (`src/Class/FeiShu.ts`). It polls every few seconds, relies on workspace settings (`dota2-tools.A8.*`), and writes KV files via `abilityCSV2KV`/`unitCSV2KV`. Reuse its helpers for any new cloud-facing tasks.
- Large static datasets (`resource/*.json`, `resource/*.txt`) back the tree views, completions, and translators. When updating them, ensure corresponding webviews or listeners refresh (e.g., `luaApiTree.refreshRawData`).
- File-system watchers live under `src/listener/`; they use `node-watch` and respect `dota2-tools.A3.listener`. When adding new watchers, mirror the opt-in/opt-out pattern and reuse `showStatusBarMessage` for user feedback.

## UI Patterns
- Tree views (`src/TreeDataProvider/*`) expect an accompanying command palette workflow (copy/edit/overview). Use `statusBar` helpers to communicate operations and update `messageList` so the tooltip history stays coherent.
- `errorLogExplorer` (see `src/TreeDataProvider/errorLogTree.ts`) pulls daily TXT logs from the URLs configured in `dota2-tools.A9.LogServer`. Keep the date format `YYYY-MM-DD.txt` and reuse its command wiring (`dota2tools.logs.open`) when adding new log categories.
- Webviews load HTML from `webview/<feature>/<feature>.html` via `getWebviewContent`; this injects VS Code toolkit + codicons and rewrites relative asset paths. Keep assets alongside the HTML to avoid broken URIs, and rely on `panel.webview.postMessage` for state updates.
- Custom editors live in `CustomTextEditorProvider/` (e.g., `lazayboyProvider`). Follow that provider’s registration pattern if you add new editors.
- Any user-facing string must pass through `localize(...)`, and you can reverse-map IDs with `reverseLocalize` when syncing settings.

## Build, Test & Release
- Install deps with `npm install`, compile once with `npm run compile`, or keep `npm run watch` running while iterating (there’s a matching VS Code task). Unit tests run through `npm run test` after `npm run compile-tests`/`lint`; use `npm run watch-tests` for incremental builds.
- Webpack bundles only the extension host code to `dist/extension.js`; webview code ships unbundled from `webview/` and `lib/`.
- Publishing is scripted in `publish_patch.js` (wraps `vsce publish patch` and auto-confirms). Make sure `vsce` is installed before executing.

## Working Guidelines
- Whenever you mutate API note data or KV outputs, also touch the cached files under `resource/` to keep offline mode consistent.
- Respect placeholder paths (`${game}`, `${content}`, `${workspace}`) by resolving them via `getPathConfiguration` or `eachExcelConfig` rather than `path.join` manually.
- Use `EventManager.fireEvent` to broadcast configuration changes so listeners refresh correctly; new modules should register themselves in `moduleList` to benefit from this wiring.
- Long-running tasks should toggle the status bar icon via `changeStatusBarState(StatusBarState.LOADING/ALL_DONE)` and log updates with `showStatusBarMessage`.
- Before introducing new dependencies, confirm they can be webpacked or add them to the `externals` list to avoid breaking bundling.
