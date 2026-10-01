import * as assert from 'assert';
import * as path from 'path';
import { addonFilePath, chapterMapsDir, localizationLanguageOf } from '../../utils/pathUtils';

suite('path helpers', () => {
	const game = path.join(path.sep, 'work', 'my_addon', 'game');

	test('addonFilePath builds native paths for the export defaults', () => {
		assert.strictEqual(addonFilePath(game, 'scripts/npc/items_game.kv'), path.join(game, 'scripts', 'npc', 'items_game.kv'));
		assert.strictEqual(addonFilePath(game, 'scripts/vscripts/modifiers/eom_modifier/modifierfunction.lua'),
			path.join(game, 'scripts', 'vscripts', 'modifiers', 'eom_modifier', 'modifierfunction.lua'));
		assert.strictEqual(addonFilePath(game, '/scripts/npc/portraits_custom.txt'), path.join(game, 'scripts', 'npc', 'portraits_custom.txt'));
		const otherSeparator = path.sep === '/' ? '\\' : '/';
		assert.ok(!addonFilePath(game, 'scripts/npc/items_game').includes(otherSeparator));
	});

	test('localizationLanguageOf takes the first folder under the localization dir', () => {
		const loc = path.join(game, 'localization');
		assert.strictEqual(localizationLanguageOf(loc, path.join(loc, 'schinese', 'abilities.txt')), 'schinese');
		assert.strictEqual(localizationLanguageOf(loc, path.join(loc, 'russian', 'heroes', 'meepo.txt')), 'russian');
		assert.strictEqual(localizationLanguageOf(loc, path.join(loc, 'addon_english.txt')), undefined);
		assert.strictEqual(localizationLanguageOf(loc, path.join(game, 'scripts', 'x.txt')), undefined);
	});

	test('chapterMapsDir works with both separators', () => {
		assert.strictEqual(chapterMapsDir('/r/game/dota_rogue'), '/r/design/tools/Decompiler-windows/maps/chapter');
		assert.strictEqual(chapterMapsDir('C:\\r\\game\\dota_rogue'), 'C:\\r\\design\\tools\\Decompiler-windows\\maps\\chapter');
	});
});
