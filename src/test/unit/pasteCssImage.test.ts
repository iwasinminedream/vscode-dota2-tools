import * as assert from 'assert';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { CommandRunner, extractFilePathFromClipboard, getImageSize, readClipboardTextOrFileList } from '../../command/cmdPasteCssImage';
import { makePng, makeTempDir, onPlatform, removeDir, writeFile } from '../helpers';
import { resetMock, state } from './vscodeMock';

/** Fake external programs: command name → stdout (or an Error to throw); every call is recorded */
function fakeRunner(outputs: { [command: string]: string | Error; }) {
	const calls: { command: string; args: string[]; }[] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push({ command, args });
		const out = outputs[command];
		if (out === undefined || out instanceof Error) {
			throw out ?? new Error(`${command}: not found`);
		}
		return { stdout: out };
	};
	return { run, calls };
}

suite('LESS image paste', () => {
	let root: string;
	let png: string;
	setup(() => {
		resetMock();
		root = makeTempDir('paste');
		png = writeFile(root, 'content/panorama/images/custom_game/icon.png', makePng(3, 2));
	});
	teardown(() => removeDir(root));

	test('getImageSize reads PNG dimensions', () => {
		assert.deepStrictEqual(getImageSize(png), { width: 3, height: 2 });
	});

	test('extractFilePathFromClipboard understands absolute paths, file:// URIs and Windows paths', () => {
		assert.strictEqual(extractFilePathFromClipboard(`"${png}"`), png);
		assert.strictEqual(extractFilePathFromClipboard(pathToFileURL(png).toString()), png);
		assert.strictEqual(extractFilePathFromClipboard('C:\\art\\icons\\poof.png'), 'C:\\art\\icons\\poof.png');
		assert.strictEqual(extractFilePathFromClipboard(`${png}\n${path.join(root, 'other.png')}`), png);
		assert.strictEqual(extractFilePathFromClipboard('icon.png'), undefined);
		assert.strictEqual(extractFilePathFromClipboard('   '), undefined);
	});

	test('macOS: a file copied in Finder (only its name in the text clipboard) is read via osascript «class furl»', () =>
		onPlatform('darwin', async () => {
			state.clipboardText = 'icon.png';
			const { run, calls } = fakeRunner({ osascript: '/Users/me/art/icon.png\n' });
			assert.strictEqual(await readClipboardTextOrFileList(run), '/Users/me/art/icon.png');
			assert.strictEqual(calls.length, 1);
			assert.strictEqual(calls[0].command, 'osascript');
			assert.ok(calls[0].args.join(' ').includes('\u00abclass furl\u00bb'));
		}));

	test('macOS: a full path in the text clipboard is used without osascript', () =>
		onPlatform('darwin', async () => {
			state.clipboardText = png;
			const { run, calls } = fakeRunner({});
			assert.strictEqual(await readClipboardTextOrFileList(run), png);
			assert.strictEqual(calls.length, 0);
		}));

	test('macOS: no file in the clipboard → the text is returned as is', () =>
		onPlatform('darwin', async () => {
			state.clipboardText = 'just text';
			const { run } = fakeRunner({ osascript: new Error("Can't make the clipboard into type «class furl»") });
			assert.strictEqual(await readClipboardTextOrFileList(run), 'just text');
		}));

	test('Linux: wl-paste is tried first, then xclip (text/uri-list)', () =>
		onPlatform('linux', async () => {
			const uri = pathToFileURL(png).toString();
			const { run, calls } = fakeRunner({ xclip: `${uri}\n` });
			const raw = await readClipboardTextOrFileList(run);
			assert.deepStrictEqual(calls.map((c) => c.command), ['wl-paste', 'xclip']);
			assert.strictEqual(extractFilePathFromClipboard(raw), png);
		}));

	test('Linux: no clipboard tools → empty text', () =>
		onPlatform('linux', async () => {
			const { run } = fakeRunner({});
			assert.strictEqual(await readClipboardTextOrFileList(run), '');
		}));

	test('Windows: an empty text clipboard falls back to the Explorer file drop list (PowerShell)', () =>
		onPlatform('win32', async () => {
			const { run, calls } = fakeRunner({ 'powershell.exe': 'C:\\art\\icon.png\r\n' });
			assert.strictEqual(extractFilePathFromClipboard(await readClipboardTextOrFileList(run)), 'C:\\art\\icon.png');
			assert.ok(calls[0].args.join(' ').includes('FileDropList'));
		}));

	test('Windows: clipboard text is used without PowerShell', () =>
		onPlatform('win32', async () => {
			state.clipboardText = 'C:\\art\\icon.png';
			const { run, calls } = fakeRunner({});
			assert.strictEqual(await readClipboardTextOrFileList(run), 'C:\\art\\icon.png');
			assert.strictEqual(calls.length, 0);
		}));
});
