import { pathExistsSync } from "fs-extra";
import { ExtensionContext } from "vscode";
import { StopAllListener, TryStartWatch } from "../listener/common";
import { getContentDir, getGameDir } from "../module/addonInfo";
import { changeStatusBarState, showStatusBarMessage, StatusBarState } from "../module/statusBar";
import { getAddonLinkTargets, linkAddonToDota } from '../utils/addonLink';
import { localize } from '../utils/localize';
import { getDota2InstallPath, revealInOS } from '../utils/platformUtils';

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
		const targets = getAddonLinkTargets(sDotaDir, contentDir);

		if (!pathExistsSync(targets.dotaContentAddons)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			showStatusBarMessage(localize('msg_content_dir_missing'));
			return;
		}

		if (!pathExistsSync(targets.dotaGameAddons)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			showStatusBarMessage(localize('msg_game_dir_missing'));
			return;
		}

		if (pathExistsSync(targets.dotaContentDir) && pathExistsSync(targets.dotaGameDir)) {
			changeStatusBarState(StatusBarState.ALL_DONE);
			return;
		}

		StopAllListener();

		const linked = linkAddonToDota(targets, gameDir, contentDir);

		if (linked.content) {
			revealInOS(targets.dotaContentDir);
		}
		if (linked.game) {
			revealInOS(targets.dotaGameDir);
		}

		TryStartWatch();
		changeStatusBarState(StatusBarState.ALL_DONE);
	}
}
