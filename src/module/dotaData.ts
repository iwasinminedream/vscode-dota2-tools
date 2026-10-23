import * as path from 'path';
import * as vscode from 'vscode';
import { EventManager, EventType } from '../Class/event';
import { DotaDataGeneration, githubSource, loadCurrent, updateDotaData, WEBVIEW_SCRIPT } from '../utils/dotaDataStore';
import { localize } from '../utils/localize';
import { setDotaDataRoot } from '../utils/releaseData';
import { showStatusBarMessage } from './statusBar';

/**
 * Keeps the API data (Lua/JS/CSS completions, the API sidebar) in step with the dota-data dumps on
 * GitHub: an hourly look-up of the newest commit under files/ (one GitHub API request, shared by all
 * windows through globalState), a download when it changed (utils/dotaDataStore.ts), then
 * EVENT_ON_DOTA_DATA_UPDATED for the modules that read the data. Until the first download, or when
 * the module is switched off, the data bundled with the extension is used.
 */

/** How long after a look-up the next one is due */
const CHECK_INTERVAL = 60 * 60 * 1000;
/** How often to see whether a look-up is due, or another window has switched the data */
const TICK_INTERVAL = 5 * 60 * 1000;
/** The first look-up after start, out of the way of the other modules' loading */
const FIRST_CHECK_DELAY = 20 * 1000;
const LAST_CHECK_KEY = 'dota2tools.dotaData.lastCheck';
const MODULE_LIST_CONFIG = 'dota2-tools.A1.module_list';

let extensionContext: vscode.ExtensionContext | undefined;
let storageDir = '';
let current: DotaDataGeneration | undefined;
let timers: NodeJS.Timeout[] = [];
/** Look-ups run one after another */
let queue: Promise<void> = Promise.resolve();
let checking = false;
let configEventID: number | undefined;
/** Generations the extension could not read (readWithBundledFallback): not used again in this session */
const rejected = new Set<string>();

export async function dotaDataInit(context: vscode.ExtensionContext) {
	// Extension tests run on the checkout's own resources, without network
	if (context.extensionMode === vscode.ExtensionMode.Test) {
		return;
	}
	extensionContext = context;
	storageDir = path.join(context.globalStorageUri.fsPath, 'dota-data');
	// At start nothing listens yet (the modules loaded after this one read the data as it is now);
	// a later init — the module switched on in the settings — tells the loaded modules
	use(loadCurrent(storageDir), true);

	if (configEventID === undefined) {
		configEventID = EventManager.listenToEvent<vscode.ConfigurationChangeEvent>(EventType.EVENT_ON_DID_CHANGE_CONFIGURATION, (event) => {
			// Switching the module back on runs this init again (init.ts)
			if (event.affectsConfiguration(MODULE_LIST_CONFIG) && !isEnabled()) {
				stop();
			}
		});
	}
	if (timers.length === 0) {
		timers.push(setTimeout(() => void check(false), FIRST_CHECK_DELAY));
		timers.push(setInterval(() => void check(false), TICK_INTERVAL));
		context.subscriptions.push({ dispose: clearTimers });
	}
}

/** Command: look up the newest dota-data now, whenever the last look-up was */
export async function updateDotaDataCommand() {
	if (extensionContext === undefined || !isEnabled()) {
		vscode.window.showInformationMessage(localize('dota_data_disabled'));
		return;
	}
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: localize('dota_data_checking') },
		() => check(true),
	);
}

/**
 * Run `read`, code that reads the API data. When it throws while downloaded data is in use, switch
 * back to the bundled data and run it again: a dump the parsers cannot handle must not break the
 * extension, now or at the next start.
 */
export function readWithBundledFallback<T>(read: () => T): T {
	try {
		return read();
	} catch (error) {
		if (current === undefined) {
			throw error;
		}
		rejected.add(current.dir);
		showStatusBarMessage(localize('dota_data_rejected', [describe(current), errorMessage(error)]));
		use(undefined, true);
		return read();
	}
}

/** The API sidebar's data script of the generation in use (undefined: the sidebar keeps its bundled data) */
export function getDotaDataWebviewScript(): string | undefined {
	return current ? path.join(current.dir, WEBVIEW_SCRIPT) : undefined;
}

function isEnabled() {
	return vscode.workspace.getConfiguration().get<ModuleListConfig>(MODULE_LIST_CONFIG)?.dota_data_update !== false;
}

/** Switch the data to `generation` (undefined: the bundled data) */
function use(generation: DotaDataGeneration | undefined, notify: boolean) {
	if (generation && rejected.has(generation.dir)) {
		generation = undefined;
	}
	const changed = generation?.dir !== current?.dir;
	current = generation;
	setDotaDataRoot(generation?.dir);
	if (changed && notify) {
		EventManager.fireEvent<DotaDataGeneration | undefined>(EventType.EVENT_ON_DOTA_DATA_UPDATED, generation);
	}
}

function stop() {
	clearTimers();
	use(undefined, true);
}

function clearTimers() {
	timers.forEach((timer) => clearInterval(timer));
	timers = [];
}

/** Look up the newest dota-data when due (`manual`: now) and switch to it */
function check(manual: boolean): Promise<void> {
	if (checking && !manual) {
		return queue;
	}
	queue = queue.then(() => runCheck(manual));
	return queue;
}

async function runCheck(manual: boolean) {
	const context = extensionContext;
	if (context === undefined || !isEnabled()) {
		return;
	}
	checking = true;
	try {
		// Another window may have switched the data already
		use(loadCurrent(storageDir), true);
		if (!manual && Date.now() - context.globalState.get<number>(LAST_CHECK_KEY, 0) < CHECK_INTERVAL) {
			return;
		}
		// Recorded first, so a failing look-up (offline, GitHub's rate limit) waits for the next interval too
		await context.globalState.update(LAST_CHECK_KEY, Date.now());
		const result = await updateDotaData(storageDir, githubSource());
		use(result.generation, true);
		if (result.updated) {
			showStatusBarMessage(localize('dota_data_updated', [describe(result.generation), describe(result.previous)]));
		}
		if (manual) {
			vscode.window.showInformationMessage(result.updated
				? localize('dota_data_updated', [describe(result.generation), describe(result.previous)])
				: localize('dota_data_up_to_date', [describe(result.generation)]));
		}
	} catch (error) {
		const message = localize('dota_data_update_failed', [errorMessage(error)]);
		showStatusBarMessage(message);
		if (manual) {
			vscode.window.showErrorMessage(message);
		}
	} finally {
		checking = false;
	}
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function describe(generation: DotaDataGeneration | undefined) {
	return generation ? `${generation.version} (${generation.sha.slice(0, 7)})` : localize('dota_data_bundled');
}
