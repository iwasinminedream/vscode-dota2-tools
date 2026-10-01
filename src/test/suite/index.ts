/** Entry point loaded by VS Code's extension host: runs every *.test.js in this folder with mocha */
import * as path from 'path';
import Mocha = require('mocha');
import glob = require('glob');

export function run(): Promise<void> {
	const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60000 });
	const testsRoot = __dirname;
	return new Promise((resolve, reject) => {
		glob('**/*.test.js', { cwd: testsRoot }, (err, files) => {
			if (err) {
				reject(err);
				return;
			}
			files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));
			try {
				mocha.run((failures) => {
					if (failures > 0) {
						reject(new Error(`${failures} integration test(s) failed.`));
					} else {
						resolve();
					}
				});
			} catch (e) {
				reject(e);
			}
		});
	});
}
