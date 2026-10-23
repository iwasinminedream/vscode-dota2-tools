import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { apiParse } from '../../utils/apiParse';
import { DOTA_DATA_FILES, DotaDataSource, GENERATED_RESOURCES, githubSource, loadCurrent, updateDotaData, WEBVIEW_SCRIPT } from '../../utils/dotaDataStore';
import { getResourcePath, resetReleasePathCache, setDotaDataRoot } from '../../utils/releaseData';
import { makeTempDir, removeDir, withHome, writeFile } from '../helpers';

const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);
const SHA3 = '3'.repeat(40);

/** A dota-data files/ set: every file the store needs, with a Lua API of one global function, one class and an enum */
function dotaFiles(version: string, extraFunction = 'AngleDiff'): { [file: string]: string; } {
	const files: { [file: string]: unknown; } = {
		'vscripts/api.json': [
			{ kind: 'function', name: 'AddFOWViewer', available: 'server', description: 'Add temporary vision for a given team.', args: [{ name: 'teamId', types: ['DOTATeam_t'] }], returns: ['ViewerID'] },
			{ kind: 'function', name: extraFunction, available: 'both', args: [{ name: 'arg1', types: ['float'] }], returns: ['float'] },
			{ kind: 'class', name: 'CDOTA_BaseNPC', clientName: 'C_DOTA_BaseNPC', members: [{ kind: 'function', name: 'GetHealth', available: 'both', args: [], returns: ['int'] }] },
		],
		'vscripts/api-types.json': [],
		'vscripts/enums.json': [
			{ kind: 'constant', name: 'DOTA_ITEM_MAX', value: 25, available: 'both' },
			{ kind: 'enum', name: 'modifierfunction', available: 'server', members: [{ name: 'MODIFIER_PROPERTY_HEALTH_BONUS', value: 0, description: 'GetModifierHealthBonus' }] },
		],
		'vscripts/modifier_list.json': { generic: ['modifier_stunned'] },
		'events.json': [],
		'panorama/api.json': [{ name: 'CScriptBindingPR_Game', members: [{ name: 'GetGameTime', args: [], returns: 'number', description: 'Game time' }] }],
		'panorama/enums.json': [{ name: 'DOTA_GameState', members: [{ name: 'DOTA_GAMERULES_STATE_INIT', value: 0 }] }],
		'panorama/css.json': { width: { description: 'Width of the panel.', examples: ['width: 100px;'] } },
		'panorama/events.json': { AddStyle: { description: 'Add a class', panelEvent: true, args: [{ name: 'class', type: 'string' }] } },
		'abilities.json': {},
		'ability-hero-map.json': {},
		'convars.json': {},
		'changelog-index.json': [{ version }],
	};
	const texts: { [file: string]: string; } = {};
	for (const file of DOTA_DATA_FILES) {
		texts[file] = JSON.stringify(files[file], null, 2);
	}
	return texts;
}

/** dota-data commits in memory; counts what the store asks for */
class FakeSource implements DotaDataSource {
	commits = new Map<string, { [file: string]: string; }>();
	latest = SHA1;
	reads = 0;
	async latestSha() {
		return this.latest;
	}
	async readFile(sha: string, file: string) {
		this.reads++;
		const text = this.commits.get(sha)?.[file];
		if (text === undefined) {
			throw new Error(`HTTP 404: ${sha}/files/${file}`);
		}
		return text;
	}
}

suite('dota-data: newest dumps from GitHub', () => {
	let storage: string;
	let source: FakeSource;
	setup(() => {
		storage = path.join(makeTempDir('dotadata'), 'dota-data');
		source = new FakeSource();
		source.commits.set(SHA1, dotaFiles('6965'));
		source.commits.set(SHA2, dotaFiles('6966', 'AnglesToVector'));
		source.commits.set(SHA3, dotaFiles('6967', 'AppendToLogFile'));
	});
	teardown(() => {
		setDotaDataRoot(undefined);
		removeDir(path.dirname(storage));
	});

	test('first look-up downloads the files and generates the resources and the sidebar script', async () => {
		assert.strictEqual(loadCurrent(storage), undefined);
		const result = await updateDotaData(storage, source);
		assert.strictEqual(result.updated, true);
		assert.strictEqual(result.previous, undefined);
		assert.deepStrictEqual({ sha: result.generation.sha, version: result.generation.version }, { sha: SHA1, version: '6965' });
		assert.deepStrictEqual(loadCurrent(storage), result.generation);
		for (const file of GENERATED_RESOURCES) {
			assert.ok(fs.existsSync(path.join(result.generation.dir, 'resource', file)), file);
		}

		const server = fs.readFileSync(path.join(result.generation.dir, 'resource', 'dota_script_help2.lua'), 'utf-8');
		assert.ok(server.includes('function AddFOWViewer( teamId ) end'), server);
		assert.ok(server.includes('function CDOTA_BaseNPC:GetHealth(  ) end'), server);
		const client = fs.readFileSync(path.join(result.generation.dir, 'resource', 'dota_cl_script_help2.lua'), 'utf-8');
		assert.ok(client.includes('function C_DOTA_BaseNPC:GetHealth(  ) end') && !client.includes('AddFOWViewer'), client);
		const js = JSON.parse(fs.readFileSync(path.join(result.generation.dir, 'resource', 'cl_panorama_script_help_2.json'), 'utf-8'));
		assert.strictEqual(js.CScriptBindingPR_Game.GetGameTime.Signature, 'Game.GetGameTime(  )');
		const css = JSON.parse(fs.readFileSync(path.join(result.generation.dir, 'resource', 'dump_panorama_css_properties.json'), 'utf-8'));
		assert.deepStrictEqual(css.width, { description: 'Width of the panel.', example: 'width: 100px;' });

		// The sidebar script defines every file as parsed JSON
		const window: { __DOTA_DATA__?: { [file: string]: unknown; }; } = {};
		vm.runInNewContext(fs.readFileSync(path.join(result.generation.dir, WEBVIEW_SCRIPT), 'utf-8'), { window });
		assert.deepStrictEqual(Object.keys(window.__DOTA_DATA__!), DOTA_DATA_FILES);
		// (the objects come from the script's own realm: compare their JSON)
		assert.strictEqual(JSON.stringify(window.__DOTA_DATA__!['changelog-index.json']), '[{"version":"6965"}]');
	});

	test('the Lua API parser reads the generated dumps, and getResourcePath prefers them', async () => {
		const extensionRoot = makeTempDir('dotadata-ext');
		try {
			await withHome(extensionRoot, async () => {
				resetReleasePathCache();
				const { generation } = await updateDotaData(storage, source);
				writeFile(extensionRoot, 'resource/dota_script_help2.lua', '---[[ Bundled  old ]]\n-- @return void\nfunction Bundled(  ) end\n');
				writeFile(extensionRoot, 'resource/dota_cl_script_help2.lua', '');
				writeFile(extensionRoot, 'resource/npc/items.txt', '"DOTAAbilities" {}');
				const context = { extensionPath: extensionRoot } as any;

				assert.strictEqual(getResourcePath(context, 'resource', 'dota_script_help2.lua'), path.join(extensionRoot, 'resource', 'dota_script_help2.lua'));
				setDotaDataRoot(generation.dir);
				assert.strictEqual(getResourcePath(context, 'resource', 'dota_script_help2.lua'), path.join(generation.dir, 'resource', 'dota_script_help2.lua'));
				// what dota-data does not generate still comes with the extension
				assert.strictEqual(getResourcePath(context, 'resource', 'npc', 'items.txt'), path.join(extensionRoot, 'resource', 'npc', 'items.txt'));

				const [classList, enumList] = apiParse(context, {});
				assert.deepStrictEqual(Object.keys(classList).sort(), ['CDOTA_BaseNPC', 'Global']);
				assert.strictEqual(classList.CDOTA_BaseNPC[0].class_cl, 'C_DOTA_BaseNPC');
				assert.deepStrictEqual(classList.Global.map((f: any) => f.function), ['AddFOWViewer', 'AngleDiff']);
				assert.deepStrictEqual(enumList.Constants.map((e: any) => [e.name, e.value]), [['DOTA_ITEM_MAX', '25']]);
				assert.strictEqual(enumList.modifierfunction[0].name, 'MODIFIER_PROPERTY_HEALTH_BONUS');
			});
		} finally {
			resetReleasePathCache();
			removeDir(extensionRoot);
		}
	});

	test('the Lua API parser takes a class only the client has (it crashed on one)', async () => {
		const extensionRoot = makeTempDir('dotadata-ext');
		try {
			await withHome(extensionRoot, async () => {
				resetReleasePathCache();
				const files = source.commits.get(SHA1)!;
				const api = JSON.parse(files['vscripts/api.json']);
				api.push({ kind: 'class', name: 'CDOTA_ClientOnly', clientName: 'C_DOTA_ClientOnly', members: [{ kind: 'function', name: 'ClientThing', available: 'client', args: [], returns: ['nil'] }] });
				files['vscripts/api.json'] = JSON.stringify(api);
				const { generation } = await updateDotaData(storage, source);
				setDotaDataRoot(generation.dir);
				const [classList] = apiParse({ extensionPath: extensionRoot } as any, {});
				assert.deepStrictEqual(classList.CDOTA_ClientOnly.map((f: any) => [f.function, f.server, f.client]), [['ClientThing', false, true]]);
			});
		} finally {
			resetReleasePathCache();
			removeDir(extensionRoot);
		}
	});

	test('the same commit again downloads nothing; a new one replaces it, and the one before is removed', async () => {
		const first = await updateDotaData(storage, source);
		const reads = source.reads;
		const again = await updateDotaData(storage, source);
		assert.strictEqual(again.updated, false);
		assert.deepStrictEqual(again.generation, first.generation);
		assert.strictEqual(source.reads, reads);

		source.latest = SHA2;
		const second = await updateDotaData(storage, source);
		assert.strictEqual(second.updated, true);
		assert.strictEqual(second.generation.version, '6966');
		assert.deepStrictEqual(second.previous, first.generation);
		assert.deepStrictEqual(loadCurrent(storage), second.generation);
		assert.ok(fs.readFileSync(path.join(second.generation.dir, 'resource', 'dota_script_help2.lua'), 'utf-8').includes('AnglesToVector'));
		// another window may still read the replaced generation until its next check
		assert.ok(fs.existsSync(first.generation.dir));

		source.latest = SHA3;
		const third = await updateDotaData(storage, source);
		assert.ok(!fs.existsSync(first.generation.dir), 'the generation two updates back stays');
		assert.ok(fs.existsSync(second.generation.dir));
		assert.deepStrictEqual(fs.readdirSync(storage).sort(), [path.basename(second.generation.dir), path.basename(third.generation.dir), 'current-g1.json'].sort());
	});

	test('a broken download changes nothing', async () => {
		const first = await updateDotaData(storage, source);
		source.latest = SHA2;
		source.commits.get(SHA2)!['vscripts/api.json'] = '[{"kind": "function",';
		await assert.rejects(updateDotaData(storage, source), /files\/vscripts\/api\.json/);
		source.commits.get(SHA2)!['vscripts/api.json'] = '{}';
		await assert.rejects(updateDotaData(storage, source), /files\/vscripts\/api\.json: expected an array/);
		delete source.commits.get(SHA2)!['panorama/css.json'];
		await assert.rejects(updateDotaData(storage, source), /HTTP 404/);
		assert.deepStrictEqual(loadCurrent(storage), first.generation);
		assert.deepStrictEqual(fs.readdirSync(storage).sort(), [path.basename(first.generation.dir), 'current-g1.json'].sort());
	});

	test('an incomplete generation is not used', async () => {
		const { generation } = await updateDotaData(storage, source);
		fs.rmSync(path.join(generation.dir, 'resource', 'dota_cl_script_help2.lua'));
		assert.strictEqual(loadCurrent(storage), undefined);
		// and the next look-up puts it right
		const repaired = await updateDotaData(storage, source);
		assert.strictEqual(repaired.updated, true);
		assert.deepStrictEqual(loadCurrent(storage), generation);
	});

	test('two windows updating at once end with the same complete generation', async () => {
		const [a, b] = await Promise.all([updateDotaData(storage, source), updateDotaData(storage, source)]);
		assert.deepStrictEqual(a.generation, b.generation);
		assert.deepStrictEqual(loadCurrent(storage), a.generation);
		assert.ok(!fs.readdirSync(storage).some((entry) => entry.includes('.tmp-')), fs.readdirSync(storage).join(', '));
	});

	test('GitHub: the newest commit under files/, the files from raw.githubusercontent.com at that commit', async () => {
		const requests: string[] = [];
		const github = githubSource('owner/dota-data', 'master', async (url) => {
			requests.push(url);
			return url.startsWith('https://api.github.com/') ? JSON.stringify([{ sha: SHA2, commit: { message: '6966' } }]) : '[]';
		});
		assert.strictEqual(await github.latestSha(), SHA2);
		assert.strictEqual(await github.readFile(SHA2, 'vscripts/api.json'), '[]');
		assert.deepStrictEqual(requests, [
			'https://api.github.com/repos/owner/dota-data/commits?sha=master&path=files&per_page=1',
			`https://raw.githubusercontent.com/owner/dota-data/${SHA2}/files/vscripts/api.json`,
		]);
		const broken = githubSource('owner/dota-data', 'master', async () => '{"message": "API rate limit exceeded"}');
		await assert.rejects(broken.latestSha(), /No commits under files\//);
	});
});
