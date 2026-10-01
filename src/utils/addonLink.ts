import { chmodSync, symlinkSync } from "fs";
import { moveSync, pathExistsSync } from "fs-extra";
import * as path from "path";

/** Where an addon lives inside the Dota 2 install */
export interface AddonLinkTargets {
	addonName: string;
	dotaGameAddons: string;
	dotaContentAddons: string;
	dotaGameDir: string;
	dotaContentDir: string;
}

/** <dota>/{game,content}/dota_addons/<addon>; the addon name is the last segment of the workspace content dir */
export function getAddonLinkTargets(dotaDir: string, contentDir: string): AddonLinkTargets {
	const addonName = path.basename(contentDir);
	const dotaGameAddons = path.join(dotaDir, "game", "dota_addons");
	const dotaContentAddons = path.join(dotaDir, "content", "dota_addons");
	return {
		addonName,
		dotaGameAddons,
		dotaContentAddons,
		dotaGameDir: path.join(dotaGameAddons, addonName),
		dotaContentDir: path.join(dotaContentAddons, addonName),
	};
}

/**
 * Move the workspace game/content folders into the Dota 2 install and leave links in their place:
 * a junction on Windows (no admin rights needed), a directory symlink on macOS/Linux.
 * A side that already exists in the Dota 2 install is left untouched.
 * @returns which sides were moved and linked
 */
export function linkAddonToDota(targets: AddonLinkTargets, gameDir: string, contentDir: string, platform: NodeJS.Platform = process.platform) {
	const isWindows = platform === "win32";
	const linkType = isWindows ? "junction" : "dir";
	const linked = { game: false, content: false };

	if (!pathExistsSync(targets.dotaGameDir)) {
		if (isWindows) {
			chmodSync(targets.dotaGameAddons, "0777");
		}
		moveSync(gameDir, targets.dotaGameDir);
		symlinkSync(targets.dotaGameDir, gameDir, linkType);
		linked.game = true;
	}

	if (!pathExistsSync(targets.dotaContentDir)) {
		if (isWindows) {
			chmodSync(targets.dotaContentAddons, "0755");
		}
		moveSync(contentDir, targets.dotaContentDir);
		symlinkSync(targets.dotaContentDir, contentDir, linkType);
		linked.content = true;
	}

	return linked;
}
