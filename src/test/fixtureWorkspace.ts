/** Throw-away addon workspace + fake Dota 2 install for the integration tests */
import * as fs from 'fs';
import * as path from 'path';
import { crlf, makePng, writeFile } from './helpers';

export const FIXTURE_ADDON = 'dota2tools_test';

export function createFixtureWorkspace(root: string) {
	const workspace = path.join(root, 'workspace');
	const dota = path.join(root, 'dota 2 beta');
	fs.mkdirSync(path.join(dota, 'game', 'dota_addons'), { recursive: true });
	fs.mkdirSync(path.join(dota, 'content', 'dota_addons'), { recursive: true });

	writeFile(workspace, '.vscode/settings.json', JSON.stringify({
		'dota2-tools.A1.module_list': {
			ability_icon: true, items_game: true, vsnd_picker: true, addon_info: true, lua_completion: true,
			js_completion: true, css_completion: true, kv_lua_associated: true, dota2kv: true,
		},
		// never the real Dota 2 install on the machine running the tests
		'dota2-tools.dota2_install_path': dota,
		'dota2-tools.A10.less_image_paste.enabled': true,
	}, null, '\t'));

	writeFile(workspace, `game/${FIXTURE_ADDON}/addoninfo.txt`, crlf('"AddonInfo"\n{\n\t"maps"\t"dota"\n}\n'));
	writeFile(workspace, `game/${FIXTURE_ADDON}/scripts/npc/npc_abilities_custom.txt`, crlf([
		'"DOTAAbilities"',
		'{',
		'\t"meepo_test_ability"',
		'\t{',
		'\t\t"BaseClass"\t"ability_lua"',
		'\t\t"ScriptFile"\t"abilities/meepo_test"',
		'\t\t"AbilityValues"',
		'\t\t{',
		'\t\t\t"damage"\t"100 200 300"',
		'\t\t}',
		'\t}',
		'}',
		'',
	].join('\n')));
	writeFile(workspace, `content/${FIXTURE_ADDON}/panorama/styles/test.less`, '.root {\n}\n');
	writeFile(workspace, `content/${FIXTURE_ADDON}/panorama/images/custom_game/icon.png`, makePng(3, 2));
	writeFile(workspace, `content/${FIXTURE_ADDON}/materials/test.vmat`, '// dummy material\n');
	writeFile(workspace, 'notes.txt', 'not an addon file\n');

	return { workspace, dota };
}
