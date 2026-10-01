/**
 * Mocha --require hook for unit tests: `require('vscode')` resolves to ./vscodeMock,
 * so extension modules load in plain Node without a VS Code instance.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');

const mockPath = require.resolve('./vscodeMock');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
	if (request === 'vscode') {
		return mockPath;
	}
	return originalResolve.call(this, request, ...rest);
};
