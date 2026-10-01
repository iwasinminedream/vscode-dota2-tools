/**
 * Integration tests: downloads VS Code into .vscode-test (separate user data and extensions,
 * the installed VS Code is not touched) and runs ./suite in it against a fixture workspace.
 */
import * as path from 'path';
import { runTests } from '@vscode/test-electron';
import { createFixtureWorkspace } from './fixtureWorkspace';
import { makeTempDir, removeDir } from './helpers';

async function main() {
	const root = makeTempDir('it');
	const { workspace, dota } = createFixtureWorkspace(root);
	try {
		await runTests({
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
	} finally {
		removeDir(root);
	}
}

main().catch((err) => {
	console.error('Integration tests failed:', err);
	process.exit(1);
});
