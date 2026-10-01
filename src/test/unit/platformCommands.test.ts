import * as assert from 'assert';
import * as path from 'path';
import { recompileResource } from '../../command/cmdRecompileResource';
import { lazayboyProvider } from '../../CustomTextEditorProvider/lazayboyProvider';
import { makeTempDir, onPlatform, removeDir, writeFile } from '../helpers';
import { resetMock, state, Uri } from './vscodeMock';

suite('platform-specific commands', () => {
	let root: string;
	setup(() => {
		resetMock();
		root = makeTempDir('commands');
	});
	teardown(() => removeDir(root));

	for (const platform of ['darwin', 'linux'] as const) {
		test(`Recompile Resource on ${platform}: a message instead of looking for resourcecompiler.exe`, () =>
			onPlatform(platform, async () => {
				const file = writeFile(root, 'content/dota_addons/my_addon/materials/x.vmat', 'x');
				await recompileResource({} as any, Uri.file(file) as any, [Uri.file(file) as any]);
				assert.deepStrictEqual(state.messages, [{ level: 'warning', text: 'msg_resourcecompiler_windows_only' }]);
			}));
	}

	test('Recompile Resource on Windows keeps the old checks (file outside content/)', () =>
		onPlatform('win32', async () => {
			const file = writeFile(root, 'notes/readme.txt', 'x');
			await recompileResource({} as any, Uri.file(file) as any);
			assert.strictEqual(state.messages.length, 1);
			assert.strictEqual(state.messages[0].text, 'msg_not_content_file');
		}));

	test('Lazyboy editor on macOS/Linux opens the file with the default application', () =>
		onPlatform('darwin', async () => {
			const file = path.join(root, 'model.lzb');
			let disposed = false;
			const panel = { webview: { html: '' }, dispose: () => { disposed = true; } };
			await new lazayboyProvider().resolveCustomEditor({ uri: Uri.file(file) } as any, panel as any);
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepStrictEqual(state.openedExternal, [file]);
			assert.ok(disposed, 'the placeholder panel was not closed');
		}));
});
