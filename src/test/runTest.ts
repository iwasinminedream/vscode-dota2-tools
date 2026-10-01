/**
 * Integration tests: downloads VS Code into .vscode-test (separate user data and extensions,
 * the installed VS Code is not touched) and runs ./suite in it against a fixture workspace.
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { createFixtureWorkspace } from './fixtureWorkspace';
import { makeTempDir, removeDir } from './helpers';

/** Whole run incl. download and VS Code start-up; a hung VS Code must not hold the CI job */
const RUN_TIMEOUT_MS = Number(process.env.DOTA2TOOLS_IT_TIMEOUT_MS) || 8 * 60 * 1000;

const log = (message: string) => console.log(`[it-runner ${new Date().toISOString()}] ${message}`);

async function main() {
	const root = makeTempDir('it');
	const { workspace, dota } = createFixtureWorkspace(root);
	log(`fixture workspace: ${workspace}`);
	const watchdog = setTimeout(() => {
		log(`no result after ${RUN_TIMEOUT_MS / 1000}s — VS Code or the extension host hung; giving up`);
		removeDir(root);
		process.exit(2);
	}, RUN_TIMEOUT_MS);
	try {
		const exitCode = await runTests({
			version: process.env.VSCODE_TEST_VERSION || 'stable',
			extensionDevelopmentPath: path.resolve(__dirname, '../../'),
			extensionTestsPath: path.resolve(__dirname, './suite/index'),
			launchArgs: [
				workspace,
				'--disable-extensions',
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes',
				'--disable-gpu',
			],
			extensionTestsEnv: {
				DOTA2TOOLS_TEST_DOTA: dota,
				CI: process.env.CI ?? '',
				DOTA2TOOLS_TEST_REVEAL: process.env.DOTA2TOOLS_TEST_REVEAL ?? '',
			},
		});
		log(`VS Code exited with ${exitCode}`);
	} finally {
		clearTimeout(watchdog);
		removeDir(root);
	}
}

main().catch((err) => {
	console.error('Integration tests failed:', err);
	process.exit(1);
});
