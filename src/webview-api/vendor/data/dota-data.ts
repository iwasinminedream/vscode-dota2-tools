// The dota-data files the sidebar shows. The bundle carries the copies it was built with (webpack
// alias to the sibling dota-data checkout); when the extension has downloaded newer dumps
// (src/module/dotaData.ts), the provider loads their data script before this bundle and the files
// in window.__DOTA_DATA__ win. Everything that shows dota-data imports it from here.
import bundledVscriptsApi from "@moddota/dota-data/files/vscripts/api";
import bundledVscriptsApiTypes from "@moddota/dota-data/files/vscripts/api-types";
import bundledVscriptsEnums from "@moddota/dota-data/files/vscripts/enums";
import bundledModifierList from "@moddota/dota-data/files/vscripts/modifier_list.json";
import bundledEvents from "@moddota/dota-data/files/events";
import bundledPanoramaApi from "@moddota/dota-data/files/panorama/api";
import bundledPanoramaEnums from "@moddota/dota-data/files/panorama/enums";
import bundledPanoramaCss from "@moddota/dota-data/files/panorama/css";
import bundledPanoramaEvents from "@moddota/dota-data/files/panorama/events";
import bundledAbilities from "@moddota/dota-data/files/abilities.json";
import bundledAbilityHeroMap from "@moddota/dota-data/files/ability-hero-map.json";
import bundledConvars from "@moddota/dota-data/files/convars.json";

const downloaded: Record<string, unknown> =
  (typeof window !== "undefined" && (window as any).__DOTA_DATA__) || {};

/** files/<file> of the downloaded dumps, or the bundled copy */
function pick<T>(file: string, bundled: T): T {
  return (downloaded[file] as T | undefined) ?? bundled;
}

export const vscriptsApi = pick("vscripts/api.json", bundledVscriptsApi);
export const vscriptsApiTypes = pick("vscripts/api-types.json", bundledVscriptsApiTypes);
export const vscriptsEnums = pick("vscripts/enums.json", bundledVscriptsEnums);
export const modifierList = pick("vscripts/modifier_list.json", bundledModifierList);
export const vscriptsEvents = pick("events.json", bundledEvents);
export const panoramaApi = pick("panorama/api.json", bundledPanoramaApi);
export const panoramaEnums = pick("panorama/enums.json", bundledPanoramaEnums);
export const panoramaCss = pick("panorama/css.json", bundledPanoramaCss);
export const panoramaEvents = pick("panorama/events.json", bundledPanoramaEvents);
export const abilities = pick("abilities.json", bundledAbilities);
export const abilityHeroMap = pick("ability-hero-map.json", bundledAbilityHeroMap);
export const convars = pick("convars.json", bundledConvars);
