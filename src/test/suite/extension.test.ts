import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { FIXTURE_ADDON } from '../fixtureWorkspace';

const EXTENSION_ID = 'iwasinminedream.dota2tools';

const workspaceDir = () => vscode.workspace.workspaceFolders![0].uri.fsPath;
const addonFile = (side: 'game' | 'content', relative: string) => path.join(workspaceDir(), side, FIXTURE_ADDON, ...relative.split('/'));

async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string, timeoutMs = 30000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (; ;) {
		const value = await probe();
		if (value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

/** Run the LESS paste command on test.less and return the inserted text */
async function pasteIntoLess(prepareClipboard: () => Thenable<void> | void): Promise<string> {
	const doc = await vscode.workspace.openTextDocument(addonFile('content', 'panorama/styles/test.less'));
	await vscode.languages.setTextDocumentLanguage(doc, 'less');
	const editor = await vscode.window.showTextDocument(doc);
	const end = doc.lineAt(doc.lineCount - 1).range.end;
	editor.selection = new vscode.Selection(end, end);
	const before = doc.getText();
	const savedClipboard = await vscode.env.clipboard.readText();
	try {
		await prepareClipboard();
		await vscode.commands.executeCommand('dota2tools.paste_css_image_snippet');
		await waitFor(() => (doc.getText() !== before ? true : undefined), 'the paste to change test.less', 10000);
		return doc.getText().slice(before.length);
	} finally {
		await vscode.env.clipboard.writeText(savedClipboard);
		await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
	}
}

function assertImageSnippet(inserted: string) {
	assert.ok(inserted.includes('width: 3px;'), `no width in: ${inserted}`);
	assert.ok(inserted.includes('height: 2px;'), `no height in: ${inserted}`);
	assert.ok(inserted.includes('url("file://{images}/custom_game/icon.png")'), `no panorama url in: ${inserted}`);
}

suite('dota2tools in VS Code', function () {
	this.timeout(120000);
	let extension: vscode.Extension<unknown>;

	suiteSetup(async () => {
		const found = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(found, `${EXTENSION_ID} is not loaded`);
		extension = found;
		await extension.activate();
	});

	test('the extension activates', () => {
		assert.strictEqual(extension.isActive, true);
	});

	test('every command contributed in package.json is registered', async () => {
		const contributed: string[] = extension.packageJSON.contributes.commands.map((c: { command: string; }) => c.command);
		let missing: string[] = [];
		try {
			await waitFor(async () => {
				const registered = new Set(await vscode.commands.getCommands(true));
				missing = contributed.filter((c) => !registered.has(c));
				return missing.length === 0 ? true : undefined;
			}, 'all commands to be registered');
		} catch {
			assert.fail(`not registered: ${missing.join(', ')}`);
		}
	});

	test('the KV editor opens a CRLF KV file', async () => {
		const file = addonFile('game', 'scripts/npc/npc_abilities_custom.txt');
		assert.ok(fs.readFileSync(file, 'utf8').includes('\r\n'), 'fixture is expected to use CRLF');
		await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'dota2tools.kv');
		await waitFor(() => {
			const tab = (vscode.window as any).tabGroups?.activeTabGroup?.activeTab;
			return tab?.input?.viewType === 'dota2tools.kv' ? true : undefined;
		}, 'the dota2tools.kv custom editor tab');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('LESS image paste: a copied image path becomes a CSS snippet', async () => {
		const png = addonFile('content', 'panorama/images/custom_game/icon.png');
		assertImageSnippet(await pasteIntoLess(() => vscode.env.clipboard.writeText(png)));
	});

	test('LESS image paste on macOS: a file copied in Finder (clipboard file reference)', async function () {
		if (process.platform !== 'darwin') {
			this.skip();
		}
		const png = addonFile('content', 'panorama/images/custom_game/icon.png');
		try {
			execFileSync('osascript', ['-e', `set the clipboard to (POSIX file "${png}")`]);
		} catch {
			this.skip(); // no pasteboard access in this session
		}
		assertImageSnippet(await pasteIntoLess(() => undefined));
	});

	test('Recompile Resource returns cleanly (outside Windows it only shows a message)', async () => {
		// On Windows a file outside content/ is used so resourcecompiler.exe is never started by the test
		const target = process.platform === 'win32'
			? path.join(workspaceDir(), 'notes.txt')
			: addonFile('content', 'materials/test.vmat');
		const uri = vscode.Uri.file(target);
		await vscode.commands.executeCommand('dota2tools.recompile_resource', uri, [uri]);
	});

	// Last: it moves the fixture's game/content folders. revealInOS opens Explorer/Finder windows,
	// so on a developer machine it only runs with DOTA2TOOLS_TEST_REVEAL=1.
	test('mklink moves game/content into the Dota 2 install, links them back and reveals them', async function () {
		if (!process.env.CI && process.env.DOTA2TOOLS_TEST_REVEAL !== '1') {
			this.skip();
		}
		const dota = process.env.DOTA2TOOLS_TEST_DOTA!;
		await vscode.commands.executeCommand('dota2tools.mklink');
		for (const [side, marker] of [['game', 'addoninfo.txt'], ['content', 'materials/test.vmat']] as const) {
			const link = path.join(workspaceDir(), side, FIXTURE_ADDON);
			const target = path.join(dota, side, 'dota_addons', FIXTURE_ADDON);
			assert.ok(fs.lstatSync(link).isSymbolicLink(), `${link} is not a link`);
			assert.strictEqual(fs.realpathSync(link), fs.realpathSync(target));
			assert.ok(fs.existsSync(path.join(target, ...marker.split('/'))), `${marker} not moved to ${target}`);
		}
	});
});
