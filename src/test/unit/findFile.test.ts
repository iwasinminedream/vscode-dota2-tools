import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { findFile } from '../../utils/findFile';
import { linkDir, makeTempDir, removeDir, writeFile } from '../helpers';

suite('findFile (addon auto-discovery)', () => {
	let root: string;
	setup(() => { root = makeTempDir('find'); });
	teardown(() => removeDir(root));

	test('finds addoninfo.txt in a nested game folder and returns a native path', async () => {
		writeFile(root, 'projects/my_addon/game/addoninfo.txt', '"AddonInfo" {}');
		writeFile(root, 'projects/my_addon/content/panorama/readme.txt', 'x');
		const result = await findFile(root, 'addoninfo.txt', 50, ['game'], ['content'], true);
		assert.ok(result, 'addoninfo.txt was not found');
		assert.strictEqual(result[0], path.join(root, 'projects', 'my_addon', 'game'));
		assert.ok(fs.existsSync(path.join(result[0], 'addoninfo.txt')));
	});

	test('follows a linked game folder (junction on Windows, symlink elsewhere)', async () => {
		const real = makeTempDir('find-real');
		try {
			writeFile(real, 'addoninfo.txt', '"AddonInfo" {}');
			fs.mkdirSync(path.join(root, 'project'));
			linkDir(real, path.join(root, 'project', 'game'));
			const result = await findFile(root, 'addoninfo.txt', 50, ['game'], ['content'], true);
			assert.ok(result, 'addoninfo.txt behind the link was not found');
			assert.strictEqual(result[0], path.join(root, 'project', 'game'));
		} finally {
			removeDir(real);
		}
	});

	test('returns false when the file does not exist', async () => {
		writeFile(root, 'a/b/c.txt', 'x');
		assert.strictEqual(await findFile(root, 'addoninfo.txt', 50, ['game'], ['content'], true), false);
	});
});
