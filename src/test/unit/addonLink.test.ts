import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { getAddonLinkTargets, linkAddonToDota } from '../../utils/addonLink';
import { makeTempDir, removeDir, writeFile } from '../helpers';

const ADDON = 'my_addon';

suite('mklink: linkAddonToDota', () => {
	let root: string;
	let dota: string;
	let gameDir: string;
	let contentDir: string;

	setup(() => {
		root = makeTempDir('mklink');
		dota = path.join(root, 'dota 2 beta');
		fs.mkdirSync(path.join(dota, 'game', 'dota_addons'), { recursive: true });
		fs.mkdirSync(path.join(dota, 'content', 'dota_addons'), { recursive: true });
		gameDir = path.dirname(writeFile(root, `project/game/${ADDON}/addoninfo.txt`, '"AddonInfo" {}'));
		contentDir = path.dirname(writeFile(root, `project/content/${ADDON}/panorama.txt`, 'content'));
	});
	teardown(() => removeDir(root));

	const assertLinked = (link: string, target: string, marker: string) => {
		assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is not a link`);
		assert.strictEqual(fs.realpathSync(link), fs.realpathSync(target));
		assert.ok(fs.existsSync(path.join(target, marker)), `${marker} was not moved into ${target}`);
		assert.ok(fs.existsSync(path.join(link, marker)), `${marker} is not reachable through ${link}`);
	};

	test('targets are <dota>/{game,content}/dota_addons/<addon>', () => {
		const targets = getAddonLinkTargets(dota, contentDir);
		assert.strictEqual(targets.addonName, ADDON);
		assert.strictEqual(targets.dotaGameDir, path.join(dota, 'game', 'dota_addons', ADDON));
		assert.strictEqual(targets.dotaContentDir, path.join(dota, 'content', 'dota_addons', ADDON));
	});

	test(`moves both folders and links them back (${process.platform === 'win32' ? 'junction' : 'symlink'})`, () => {
		const targets = getAddonLinkTargets(dota, contentDir);
		const linked = linkAddonToDota(targets, gameDir, contentDir);
		assert.deepStrictEqual(linked, { game: true, content: true });
		assertLinked(gameDir, targets.dotaGameDir, 'addoninfo.txt');
		assertLinked(contentDir, targets.dotaContentDir, 'panorama.txt');
		if (process.platform !== 'win32') {
			assert.strictEqual(fs.readlinkSync(gameDir), targets.dotaGameDir);
		}
	});

	test('only game is missing in Dota: game is moved, content is left alone', () => {
		const targets = getAddonLinkTargets(dota, contentDir);
		writeFile(targets.dotaContentDir, 'already.txt', 'x');
		const linked = linkAddonToDota(targets, gameDir, contentDir);
		assert.deepStrictEqual(linked, { game: true, content: false });
		assertLinked(gameDir, targets.dotaGameDir, 'addoninfo.txt');
		assert.ok(!fs.lstatSync(contentDir).isSymbolicLink());
		assert.ok(fs.existsSync(path.join(contentDir, 'panorama.txt')));
	});

	test('only content is missing in Dota: content is moved, game is left alone', () => {
		const targets = getAddonLinkTargets(dota, contentDir);
		writeFile(targets.dotaGameDir, 'already.txt', 'x');
		const linked = linkAddonToDota(targets, gameDir, contentDir);
		assert.deepStrictEqual(linked, { game: false, content: true });
		assertLinked(contentDir, targets.dotaContentDir, 'panorama.txt');
		assert.ok(!fs.lstatSync(gameDir).isSymbolicLink());
	});

	test('both already in Dota: nothing is touched', () => {
		const targets = getAddonLinkTargets(dota, contentDir);
		fs.mkdirSync(targets.dotaGameDir);
		fs.mkdirSync(targets.dotaContentDir);
		assert.deepStrictEqual(linkAddonToDota(targets, gameDir, contentDir), { game: false, content: false });
		assert.ok(fs.existsSync(path.join(gameDir, 'addoninfo.txt')));
		assert.ok(fs.existsSync(path.join(contentDir, 'panorama.txt')));
	});
});
