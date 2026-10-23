import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { extractZip, vrfAssetName, vrfBinaryName } from '../../../scripts/ensure-vrf';
import { dotaVpk, findDota2, steamLibraries, steamRoots } from '../../../scripts/lib/dota-install';
import { makeTempDir, makeZip, onPlatform, removeDir, withHome, writeFile } from '../helpers';

suite('VPK scripts on Windows, macOS and Linux: ValveResourceFormat CLI', () => {
	test('the release asset for each platform and CPU', () => {
		assert.strictEqual(vrfAssetName('win32', 'x64'), 'cli-windows-x64.zip');
		assert.strictEqual(vrfAssetName('win32', 'arm64'), 'cli-windows-arm64.zip');
		assert.strictEqual(vrfAssetName('darwin', 'arm64'), 'cli-macos-arm64.zip');
		assert.strictEqual(vrfAssetName('darwin', 'x64'), 'cli-macos-x64.zip');
		assert.strictEqual(vrfAssetName('linux', 'x64'), 'cli-linux-x64.zip');
		assert.strictEqual(vrfAssetName('linux', 'arm64'), 'cli-linux-arm64.zip');
		assert.throws(() => vrfAssetName('win32', 'ia32'), /no build for win32-ia32/);
		assert.throws(() => vrfAssetName('freebsd', 'x64'), /no build for freebsd-x64/);
	});

	test('the executable is Source2Viewer-CLI.exe on Windows only', () => {
		assert.strictEqual(vrfBinaryName('win32'), 'Source2Viewer-CLI.exe');
		assert.strictEqual(vrfBinaryName('darwin'), 'Source2Viewer-CLI');
		assert.strictEqual(vrfBinaryName('linux'), 'Source2Viewer-CLI');
	});

	test(`a release zip extracts with the system's tools (${process.platform}), the CLI stays executable`, function () {
		this.timeout(60000);
		const root = makeTempDir('vrfzip');
		try {
			const zip = writeFile(root, 'cli.zip', makeZip([
				{ name: 'Source2Viewer-CLI', data: '#!/bin/sh\necho vrf\n', mode: 0o755 },
				{ name: 'libSkiaSharp.so', data: 'library' },
			]));
			const out = path.join(root, 'vrf');
			fs.mkdirSync(out);
			extractZip(zip, out);
			assert.strictEqual(fs.readFileSync(path.join(out, 'Source2Viewer-CLI'), 'utf8'), '#!/bin/sh\necho vrf\n');
			assert.strictEqual(fs.readFileSync(path.join(out, 'libSkiaSharp.so'), 'utf8'), 'library');
			if (process.platform !== 'win32') {
				assert.ok(fs.statSync(path.join(out, 'Source2Viewer-CLI')).mode & 0o100, 'no exec bit');
			}
		} finally {
			removeDir(root);
		}
	});
});

suite('VPK scripts on Windows, macOS and Linux: finding Dota 2', () => {
	let home: string;
	const originalDotaDir = process.env.DOTA2_DIR;
	setup(() => {
		home = makeTempDir('dotahome');
		delete process.env.DOTA2_DIR;
	});
	teardown(() => {
		if (originalDotaDir === undefined) {
			delete process.env.DOTA2_DIR;
		} else {
			process.env.DOTA2_DIR = originalDotaDir;
		}
		removeDir(home);
	});

	/** A Dota 2 install with its main VPK under a Steam library */
	const installDota = (library: string) => {
		const dota = path.join(library, 'steamapps', 'common', 'dota 2 beta');
		writeFile(dota, 'game/dota/pak01_dir.vpk', 'VPK');
		return dota;
	};

	test('Steam roots: macOS, Linux (incl. Flatpak) and Windows', () => withHome(home, async () => {
		await onPlatform('darwin', () => assert.deepStrictEqual(steamRoots(), [path.join(home, 'Library', 'Application Support', 'Steam')]));
		await onPlatform('linux', () => assert.deepStrictEqual(steamRoots(), [
			path.join(home, '.steam', 'steam'),
			path.join(home, '.local', 'share', 'Steam'),
			path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'),
		]));
		await onPlatform('win32', () => assert.deepStrictEqual(steamRoots(), ['C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam']));
	}));

	test('Linux: Dota in Steam from Flathub is found', () => onPlatform('linux', () => withHome(home, () => {
		const expected = installDota(path.join(home, '.var', 'app', 'com.valvesoftware.Steam', '.local', 'share', 'Steam'));
		assert.strictEqual(findDota2(), expected);
	})));

	test('libraryfolders.vdf: libraries with Windows-escaped and POSIX paths', () => {
		const root = path.join(home, 'Steam');
		writeFile(root, 'steamapps/libraryfolders.vdf', [
			'"libraryfolders"',
			'{',
			'\t"0"\t{ "path"\t\t"C:\\\\Program Files (x86)\\\\Steam" }',
			'\t"1"\t{ "path"\t\t"D:\\\\SteamLibrary" }',
			'\t"2"\t{ "path"\t\t"/mnt/games/SteamLibrary" }',
			'}',
		].join('\n'));
		assert.deepStrictEqual(steamLibraries(root), [root, 'C:\\Program Files (x86)\\Steam', 'D:\\SteamLibrary', '/mnt/games/SteamLibrary']);
	});

	test('macOS: Dota in a second library from libraryfolders.vdf is found', () => onPlatform('darwin', () => withHome(home, () => {
		const steam = path.join(home, 'Library', 'Application Support', 'Steam');
		const library = path.join(home, 'Volumes', 'Games', 'SteamLibrary');
		writeFile(steam, 'steamapps/libraryfolders.vdf', `"libraryfolders" { "1" { "path" "${library.replace(/\\/g, '\\\\')}" } }`);
		const expected = installDota(library);
		assert.strictEqual(findDota2(), expected);
	})));

	test('an explicit path, then DOTA2_DIR, win over the Steam libraries; only installs with the VPK count', () => onPlatform('linux', () => withHome(home, () => {
		const fromSteam = installDota(path.join(home, '.steam', 'steam'));
		const fromEnv = installDota(path.join(home, 'env'));
		const explicit = installDota(path.join(home, 'explicit'));
		assert.strictEqual(findDota2(), fromSteam);
		process.env.DOTA2_DIR = fromEnv;
		assert.strictEqual(findDota2(), fromEnv);
		assert.strictEqual(findDota2(explicit), explicit);
		// a folder without game/dota/pak01_dir.vpk is skipped
		assert.strictEqual(findDota2(path.join(home, 'nothing here')), fromEnv);
		assert.strictEqual(dotaVpk(explicit), path.join(explicit, 'game', 'dota', 'pak01_dir.vpk'));
	})));

	test('nothing installed: undefined', () => onPlatform('darwin', () => withHome(home, () => {
		assert.strictEqual(findDota2(), undefined);
	})));
});
