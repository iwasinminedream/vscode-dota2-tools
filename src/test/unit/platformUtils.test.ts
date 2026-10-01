import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getDota2InstallPath, revealInOS } from '../../utils/platformUtils';
import { makeTempDir, onPlatform, removeDir, withHome, writeFile } from '../helpers';
import { resetMock, state } from './vscodeMock';

const SETTING = 'dota2-tools.dota2_install_path';
const WINDOWS_DEFAULT = 'C:/Program Files (x86)/Steam/steamapps/common/dota 2 beta';

const dotaUnder = (steamRoot: string) => path.join(steamRoot, 'steamapps', 'common', 'dota 2 beta');
const install = (steamRoot: string) => {
	fs.mkdirSync(dotaUnder(steamRoot), { recursive: true });
	return dotaUnder(steamRoot);
};

suite('getDota2InstallPath', () => {
	let home: string;
	setup(() => {
		resetMock();
		home = makeTempDir('home');
	});
	teardown(() => removeDir(home));

	const macSteam = () => path.join(home, 'Library', 'Application Support', 'Steam');
	const linuxSteam = () => path.join(home, '.steam', 'steam');
	const linuxSteamShare = () => path.join(home, '.local', 'share', 'Steam');

	test('Windows: the setting is returned as is', () => onPlatform('win32', () => {
		state.config[SETTING] = 'D:/Games/Steam/steamapps/common/dota 2 beta';
		assert.strictEqual(getDota2InstallPath(), 'D:/Games/Steam/steamapps/common/dota 2 beta');
	}));

	test('macOS: the Windows default is ignored, Dota is found in ~/Library/Application Support/Steam', () =>
		onPlatform('darwin', () => withHome(home, () => {
			state.config[SETTING] = WINDOWS_DEFAULT;
			const expected = install(macSteam());
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('macOS: a backslash Windows path synced from a Windows machine is ignored too', () =>
		onPlatform('darwin', () => withHome(home, () => {
			state.config[SETTING] = 'D:\\SteamLibrary\\steamapps\\common\\dota 2 beta';
			const expected = install(macSteam());
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('macOS: an empty setting falls back to the Steam search', () =>
		onPlatform('darwin', () => withHome(home, () => {
			state.config[SETTING] = '';
			const expected = install(macSteam());
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('macOS: a POSIX path in the setting wins over the search', () =>
		onPlatform('darwin', () => withHome(home, () => {
			install(macSteam());
			state.config[SETTING] = '/Volumes/Games/SteamLibrary/steamapps/common/dota 2 beta';
			assert.strictEqual(getDota2InstallPath(), '/Volumes/Games/SteamLibrary/steamapps/common/dota 2 beta');
		})));

	test('Linux: Dota is found in ~/.steam/steam', () =>
		onPlatform('linux', () => withHome(home, () => {
			state.config[SETTING] = WINDOWS_DEFAULT;
			const expected = install(linuxSteam());
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('Linux: ~/.local/share/Steam is searched when ~/.steam/steam has no Dota', () =>
		onPlatform('linux', () => withHome(home, () => {
			state.config[SETTING] = WINDOWS_DEFAULT;
			fs.mkdirSync(path.join(linuxSteam(), 'steamapps'), { recursive: true });
			const expected = install(linuxSteamShare());
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('libraryfolders.vdf: Dota installed in a secondary Steam library is found', () =>
		onPlatform('darwin', () => withHome(home, () => {
			state.config[SETTING] = WINDOWS_DEFAULT;
			const library = path.join(home, 'Volumes', 'Games', 'SteamLibrary');
			const expected = install(library);
			// Steam escapes backslashes in vdf strings (Windows-style paths when the tests run on Windows)
			const vdfPath = library.replace(/\\/g, '\\\\');
			writeFile(macSteam(), 'steamapps/libraryfolders.vdf', [
				'"libraryfolders"',
				'{',
				'\t"0"',
				'\t{',
				`\t\t"path"\t\t"${macSteam().replace(/\\/g, '\\\\')}"`,
				'\t\t"apps"\t\t{ }',
				'\t}',
				'\t"1"',
				'\t{',
				`\t\t"path"\t\t"${vdfPath}"`,
				'\t\t"apps"\t\t{ "570"\t\t"0" }',
				'\t}',
				'}',
			].join('\r\n'));
			assert.strictEqual(getDota2InstallPath(), expected);
		})));

	test('nothing installed: the default location under the platform Steam root is returned', () =>
		onPlatform('darwin', () => withHome(home, () => {
			state.config[SETTING] = WINDOWS_DEFAULT;
			assert.strictEqual(getDota2InstallPath(), dotaUnder(macSteam()));
		})));
});

suite('revealInOS', () => {
	setup(resetMock);

	test('uses the built-in revealFileInOS command (Explorer / Finder / file manager)', () => {
		const target = path.join(path.sep, 'tmp', 'addon', 'game');
		revealInOS(target);
		assert.strictEqual(state.executedCommands.length, 1);
		assert.strictEqual(state.executedCommands[0].command, 'revealFileInOS');
		assert.strictEqual((state.executedCommands[0].args[0] as { fsPath: string; }).fsPath, target);
	});
});
