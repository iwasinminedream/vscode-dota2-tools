/** Entry point loaded by VS Code's extension host: runs every *.test.js in this folder with mocha */
import * as path from 'path';
import Mocha = require('mocha');
import glob = require('glob');

/** Per test (hooks included) */
const TEST_TIMEOUT_MS = 60 * 1000;
/** Whole suite inside the extension host */
const SUITE_TIMEOUT_MS = 5 * 60 * 1000;

export const log = (message: string) => console.log(`[it ${new Date().toISOString()}] ${message}`);

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: TEST_TIMEOUT_MS });
	// Start/end of every test, so a CI log shows where a hang happened
	mocha.suite.beforeEach(function () {
		log(`start: ${this.currentTest?.fullTitle()}`);
	});
	mocha.suite.afterEach(function () {
		log(`end:   ${this.currentTest?.fullTitle()} → ${this.currentTest?.state ?? 'pending'} (${this.currentTest?.duration ?? 0} ms)`);
	});
	const testsRoot = __dirname;
	return new Promise((resolve, reject) => {
		const watchdog = setTimeout(() => reject(new Error(`integration suite did not finish in ${SUITE_TIMEOUT_MS / 1000}s`)), SUITE_TIMEOUT_MS);
		const finish = (error?: Error) => {
			clearTimeout(watchdog);
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		};
		glob('**/*.test.js', { cwd: testsRoot }, (err, files) => {
			if (err) {
				finish(err);
				return;
			}
			files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
			log(`running ${files.length} file(s)`);
			try {
				mocha.run((failures) => finish(failures > 0 ? new Error(`${failures} integration test(s) failed.`) : undefined));
			} catch (e) {
				finish(e as Error);
			}
		});
	});
}
