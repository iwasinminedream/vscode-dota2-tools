import { chmodSync, symlinkSync } from "fs";
import { moveSync, pathExistsSync } from "fs-extra";
import { ExtensionContext, workspace } from "vscode";
import { StopAllListener, TryStartWatch } from "../listener/common";
import { getContentDir, getGameDir } from "../module/addonInfo";
import { changeStatusBarState, showStatusBarMessage, StatusBarState } from "../module/statusBar";
import { getRootPath } from "../utils/getRootPath";
import { localize } from '../utils/localize';
import { getDota2InstallPath, revealInOS } from '../utils/platformUtils';
import path = require("path");

export async function mklinkForDota2Addon(context: ExtensionContext) {
	const sDotaDir = getDota2InstallPath();
	if (sDotaDir) {
		if (!pathExistsSync(sDotaDir)) {
			showStatusBarMessage(localize('msg_config_dota2_dir'));
			return;
		}

		changeStatusBarState(StatusBarState.LOADING);
		const contentDir = getContentDir();
		const gameDir = getGameDir();
		const rootPath = getRootPath() as string;
		const sGameName = path.basename(contentDir);
		const sDotaContentAddon = path.join(sDotaDir, "content", "dota_addons");
		const sDotaGameAddon = path.join(sDotaDir, "game", "dota_addons");
		const sDotaContentDir = path.join(sDotaContentAddon, sGameName);
		const sDotaGameDir = path.join(sDotaGameAddon, sGameName);

		if (!pathExistsSync(sDotaContentAddon)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			showStatusBarMessage(localize('msg_content_dir_missing'));
			return;
		}

		if (!pathExistsSync(sDotaGameAddon)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			showStatusBarMessage(localize('msg_game_dir_missing'));
			return;
		}

		let bContentNotExist = !pathExistsSync(sDotaContentDir);
		let bGameNotExist = !pathExistsSync(sDotaGameDir);
		if (!(bContentNotExist || bGameNotExist)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			return;
		}

		StopAllListener();

		// Windows: junction (no admin rights needed); macOS/Linux: ordinary directory symlink
		const isWindows = process.platform === "win32";
		const linkType = isWindows ? "junction" : "dir";

		if (bGameNotExist) {
			if (isWindows) {
				chmodSync(sDotaGameAddon, "0777");
			}
			moveSync(gameDir, sDotaGameDir);
			symlinkSync(sDotaGameDir, gameDir, linkType);
		}

		if (bContentNotExist) {
			if (isWindows) {
				chmodSync(sDotaContentAddon, "0755");
			}
			moveSync(contentDir, sDotaContentDir);
			symlinkSync(sDotaContentDir, contentDir, linkType);
		}

		if (bContentNotExist) {
			revealInOS(sDotaContentDir);
		}
		if (bGameNotExist) {
			revealInOS(sDotaGameDir);
		}

		TryStartWatch();
		changeStatusBarState(StatusBarState.ALL_DONE);
	}
}