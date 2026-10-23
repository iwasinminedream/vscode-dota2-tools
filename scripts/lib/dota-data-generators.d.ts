/* Types for dota-data-generators.js (shared by scripts/sync-dota-data.js and the extension). The inputs
   are the parsed files/*.json of @moddota/dota-data; only the fields the generators read are typed. */

/** files/vscripts/api.json + enums.json → dota_script_help2.json */
export function luaApiJson(api: unknown[], enums: unknown[]): { class_list: Record<string, unknown[]>; enum_list: Record<string, unknown[]> };

/** files/vscripts/api.json + enums.json → dota_script_help2.lua (server) and dota_cl_script_help2.lua (client) */
export function luaDumps(api: unknown[], enums: unknown[]): { server: string; client: string };

/** files/panorama/api.json + enums.json → cl_panorama_script_help_2.json and .txt */
export function panoramaApi(api: unknown[], enums: unknown[]): { json: Record<string, Record<string, unknown>>; txt: string };

/** files/panorama/css.json → dump_panorama_css_properties.json */
export function panoramaCss(css: Record<string, unknown>): Record<string, { description: string; example?: string }>;

/** files/panorama/events.json → dump_panorama_events.md and .txt */
export function panoramaEvents(events: Record<string, unknown>): { md: string; txt: string };
