/**
 * dotaDataStore.ts
 *
 * A copy of @moddota/dota-data in the extension's global storage, kept in step with the dumps the
 * dota-data automation pushes to GitHub (files/ of iwasinminedream/dota-data, a commit per Dota
 * update), and the files generated from it: the resource/ files the Lua/JS/CSS completions read
 * (getResourcePath prefers them over the bundled copies) and the data script of the API sidebar.
 * No `vscode` import, so the unit tests run it in plain Node; module/dotaData.ts drives it.
 *
 * Storage folder (shared by every installed copy of the extension, e.g. a dev build and a release,
 * so each GENERATOR_VERSION keeps its own pointer and folders):
 *   current-g<N>.json        { sha, version, dir }: the generation in use
 *   <sha12>-g<N>/            one generation:
 *     files/<file>             the dota-data files at that commit (DOTA_DATA_FILES)
 *     resource/<file>          generated from them (GENERATED_RESOURCES)
 *     dota-data.js             window.__DOTA_DATA__ = { "<file>": <json>, ... } for the API sidebar
 * A generation is written to a temporary folder and renamed into place, then the pointer is
 * replaced, so neither a crash nor a second VS Code window ever sees a half-written one.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as generators from '../../scripts/lib/dota-data-generators';
import { httpGet } from './httpGet';

export const DOTA_DATA_REPO = 'iwasinminedream/dota-data';
export const DOTA_DATA_BRANCH = 'master';

/** The dota-data files (under files/) the extension uses: the completion sources and everything the API sidebar imports */
export const DOTA_DATA_FILES = [
	'vscripts/api.json',
	'vscripts/api-types.json',
	'vscripts/enums.json',
	'vscripts/modifier_list.json',
	'events.json',
	'panorama/api.json',
	'panorama/enums.json',
	'panorama/css.json',
	'panorama/events.json',
	'abilities.json',
	'ability-hero-map.json',
	'convars.json',
	'changelog-index.json',
];

/** DOTA_DATA_FILES that hold a JSON array (the others hold an object) */
const ARRAY_FILES = [
	'vscripts/api.json',
	'vscripts/api-types.json',
	'vscripts/enums.json',
	'events.json',
	'panorama/api.json',
	'panorama/enums.json',
	'changelog-index.json',
];

/** Files of a generation that replace the bundled resource/ copies */
export const GENERATED_RESOURCES = [
	'dota_script_help2.lua',
	'dota_cl_script_help2.lua',
	'cl_panorama_script_help_2.json',
	'dump_panorama_css_properties.json',
];

/** The API sidebar's data script in a generation folder */
export const WEBVIEW_SCRIPT = 'dota-data.js';

/** Bump when what a generation contains changes: the next check downloads a fresh one */
export const GENERATOR_VERSION = 1;

const POINTER = `current-g${GENERATOR_VERSION}.json`;
const OWN_ENTRY = new RegExp(`^[0-9a-f]{12}-g${GENERATOR_VERSION}(\\.tmp-.+)?$`);
const OTHER_ENTRY = /^([0-9a-f]{12}-g\d+(\.tmp-.+)?|current-g\d+\.json)$/;
/** A temporary folder this old is left over from a crash (a live one takes seconds) */
const STALE_TMP_MS = 60 * 60 * 1000;
/** Folders of other generator versions unused this long belong to a copy of the extension that is gone */
const STALE_OTHER_MS = 30 * 24 * 60 * 60 * 1000;

export interface DotaDataGeneration {
	/** dota-data commit the files come from */
	sha: string;
	/** Dota version of the dump (ClientVersion, from files/changelog-index.json) */
	version: string;
	/** Absolute path of the generation folder */
	dir: string;
}

export interface DotaDataSource {
	/** The newest dota-data commit that changed files/ */
	latestSha(): Promise<string>;
	/** Text of files/<file> at commit `sha` */
	readFile(sha: string, file: string): Promise<string>;
}

/** dota-data on GitHub: one API request for the newest commit under files/, the files themselves from raw.githubusercontent.com at that commit */
export function githubSource(repo = DOTA_DATA_REPO, branch = DOTA_DATA_BRANCH, get = httpGet): DotaDataSource {
	return {
		async latestSha() {
			const body = await get(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&path=files&per_page=1`, { Accept: 'application/vnd.github+json' });
			const commits = JSON.parse(body);
			const sha = Array.isArray(commits) ? commits[0]?.sha : undefined;
			if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
				throw new Error(`No commits under files/ in ${repo}@${branch}`);
			}
			return sha;
		},
		readFile: (sha, file) => get(`https://raw.githubusercontent.com/${repo}/${sha}/files/${file}`),
	};
}

export interface UpdateResult {
	/** false: the newest commit is the one already in use */
	updated: boolean;
	generation: DotaDataGeneration;
	previous?: DotaDataGeneration;
}

/**
 * Bring the storage to the newest dota-data commit. Throws on network or data errors; the generation
 * in use stays as it was.
 */
export async function updateDotaData(storageDir: string, source: DotaDataSource): Promise<UpdateResult> {
	const previous = loadCurrent(storageDir);
	const sha = await source.latestSha();
	if (previous && previous.sha === sha) {
		return { updated: false, generation: previous };
	}
	const texts: { [file: string]: string; } = {};
	await Promise.all(DOTA_DATA_FILES.map(async (file) => {
		texts[file] = await source.readFile(sha, file);
	}));
	const generation = writeGeneration(storageDir, sha, texts);
	prune(storageDir, [generation.dir, previous?.dir]);
	return { updated: true, generation, previous };
}

/** The generation in use, or undefined when there is none or it is incomplete */
export function loadCurrent(storageDir: string): DotaDataGeneration | undefined {
	try {
		const pointer = JSON.parse(fs.readFileSync(path.join(storageDir, POINTER), 'utf-8'));
		if (typeof pointer?.sha === 'string' && typeof pointer.dir === 'string' && OWN_ENTRY.test(pointer.dir) && !pointer.dir.includes('.tmp-')) {
			const dir = path.join(storageDir, pointer.dir);
			if (isComplete(dir)) {
				return { sha: pointer.sha, version: String(pointer.version ?? ''), dir };
			}
		}
	} catch {
		// no pointer yet, or a broken one: as if there were none
	}
	return undefined;
}

/** Parse and check the files, generate from them, write the generation and make it current */
function writeGeneration(storageDir: string, sha: string, texts: { [file: string]: string; }): DotaDataGeneration {
	const data: { [file: string]: any; } = {};
	for (const file of DOTA_DATA_FILES) {
		const text = texts[file] = (texts[file] ?? '').replace(/^﻿/, '');
		try {
			data[file] = JSON.parse(text);
		} catch (error) {
			throw new Error(`files/${file}: ${error instanceof Error ? error.message : error}`);
		}
		if (typeof data[file] !== 'object' || data[file] === null || Array.isArray(data[file]) !== ARRAY_FILES.includes(file)) {
			throw new Error(`files/${file}: expected ${ARRAY_FILES.includes(file) ? 'an array' : 'an object'}`);
		}
	}
	const version = String(data['changelog-index.json'][0]?.version ?? '');
	const lua = generators.luaDumps(data['vscripts/api.json'], data['vscripts/enums.json']);
	const resources: { [file: string]: string; } = {
		'dota_script_help2.lua': lua.server,
		'dota_cl_script_help2.lua': lua.client,
		'cl_panorama_script_help_2.json': JSON.stringify(generators.panoramaApi(data['panorama/api.json'], data['panorama/enums.json']).json),
		'dump_panorama_css_properties.json': JSON.stringify(generators.panoramaCss(data['panorama/css.json'])),
	};
	// JSON is valid JavaScript, so the file texts go into the script as they are
	const script = 'window.__DOTA_DATA__ = {\n' + DOTA_DATA_FILES.map((file) => `${JSON.stringify(file)}: ${texts[file]}`).join(',\n') + '\n};\n';

	fs.mkdirSync(storageDir, { recursive: true });
	const name = `${sha.slice(0, 12)}-g${GENERATOR_VERSION}`;
	const dir = path.join(storageDir, name);
	if (!isComplete(dir)) {
		const tmp = path.join(storageDir, `${name}.tmp-${process.pid}-${Date.now()}`);
		try {
			for (const file of DOTA_DATA_FILES) {
				writeFile(path.join(tmp, 'files', ...file.split('/')), texts[file]);
			}
			for (const file of GENERATED_RESOURCES) {
				writeFile(path.join(tmp, 'resource', file), resources[file]);
			}
			writeFile(path.join(tmp, WEBVIEW_SCRIPT), script);
			fs.rmSync(dir, { recursive: true, force: true });
			try {
				fs.renameSync(tmp, dir);
			} catch (error) {
				// another window has just put the same generation in place
				if (!isComplete(dir)) {
					throw error;
				}
			}
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}

	const pointerTmp = path.join(storageDir, `${POINTER}.tmp-${process.pid}-${Date.now()}`);
	fs.writeFileSync(pointerTmp, JSON.stringify({ sha, version, dir: name }, null, '\t'));
	fs.renameSync(pointerTmp, path.join(storageDir, POINTER));
	return { sha, version, dir };
}

function isComplete(dir: string) {
	return [
		...DOTA_DATA_FILES.map((file) => path.join('files', ...file.split('/'))),
		...GENERATED_RESOURCES.map((file) => path.join('resource', file)),
		WEBVIEW_SCRIPT,
	].every((file) => fs.existsSync(path.join(dir, file)));
}

function writeFile(file: string, text: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text, 'utf-8');
}

/**
 * Remove this generator version's generations other than `keep` (the new one and the one it
 * replaced: another window may read that until its next check), temporary folders left by a crash,
 * and what other generator versions have not touched for a month.
 */
function prune(storageDir: string, keep: (string | undefined)[]) {
	const kept = new Set(keep.filter((dir): dir is string => !!dir).map((dir) => path.basename(dir)));
	for (const entry of fs.readdirSync(storageDir)) {
		if (kept.has(entry) || entry === POINTER || !OTHER_ENTRY.test(entry)) {
			continue;
		}
		const full = path.join(storageDir, entry);
		try {
			const age = Date.now() - fs.statSync(full).mtimeMs;
			const own = OWN_ENTRY.test(entry);
			if (entry.includes('.tmp-') ? age < STALE_TMP_MS : !own && age < STALE_OTHER_MS) {
				continue;
			}
			fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// in use (Windows) or already gone: the next update tries again
		}
	}
}
