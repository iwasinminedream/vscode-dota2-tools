# Changelog

## 2.0.1
- API sidebar: signature badges (s/c, GitHub) now sit to the right of the declaration, not below
- API sidebar: function signatures with many arguments wrap per-argument instead of breaking mid-token
- API search: enum types (e.g. `DOTA_ABILITY_BEHAVIOR`) render as a single block, still findable by member name
- API search: clicking a type/element link keeps the current source filter instead of jumping to "All"
- API: removed the Google/magnifier badge and the non-functional `#` link; removed `#` under Panorama CSS properties
- API: GitHub search now builds a correct query for Panorama (drops the C++ binding-class prefix)
- Localization: new tab reusing the ModDota site browser, grouped by entity (hero / ability / item / modifier) with display-name headers
- Localization: language blocks on top (RU / EN / ZH only); removed "Collapse all" and the search clear button
- Icons: removed the broken hero-filter thumbnail from the search bar
- Abilities: added a button to copy just the ability's internal name (site + extension)
- JS completions: fixed `$.M` + Tab inserting a duplicated prefix (`$.$.Msg(...)`)
- Debug: fixed the `npm: watch` task problem matcher so F5 no longer prompts about a missing problemMatcher

## 2.0.0
- Rewrote the API browsers into a single activity-bar sidebar reusing the ModDota site's React components
- Tabs: API search, Panels, Icons, items_game, Music

## 1.0.0
- Fork from BigCiba/vscode-dota2-tools
- Remove Excel/CSV, cloud sheets, and translate features
- Add VPK sync scripts for extracting images and data from Dota 2
- Rename extension to dota2tools (publisher: iwasinminedream)
- Remove bundled images from repo (users extract locally)
