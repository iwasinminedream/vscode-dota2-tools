/** Helpers shared by unit and integration tests (no `vscode` import) */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

export function makeTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `dota2tools-${prefix}-`));
}

export function removeDir(dir: string) {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Write a file (creating parent folders); `relative` is '/'-separated */
export function writeFile(root: string, relative: string, content: string | Buffer): string {
	const full = path.join(root, ...relative.split('/'));
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, content);
	return full;
}

export const crlf = (text: string) => text.replace(/\r?\n/g, '\r\n');
export const lf = (text: string) => text.replace(/\r\n/g, '\n');

/** Directory link: junction on Windows (no admin rights), symlink elsewhere */
export function linkDir(target: string, link: string) {
	fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Run `fn` with `process.platform` faked */
export async function onPlatform(platform: NodeJS.Platform, fn: () => unknown) {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
	Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
	try {
		await fn();
	} finally {
		Object.defineProperty(process, 'platform', descriptor);
	}
}

/** Run `fn` with `os.EOL` faked, to exercise Windows ('\r\n') and macOS/Linux ('\n') behaviour on any host */
export async function withEol(eol: '\r\n' | '\n', fn: () => unknown) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const nodeOs = require('os');
	const descriptor = Object.getOwnPropertyDescriptor(nodeOs, 'EOL')!;
	Object.defineProperty(nodeOs, 'EOL', { ...descriptor, value: eol });
	try {
		await fn();
	} finally {
		Object.defineProperty(nodeOs, 'EOL', descriptor);
	}
}

/** Run `fn` with `os.homedir()` returning `home` */
export async function withHome(home: string, fn: () => unknown) {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const nodeOs = require('os');
	const original = nodeOs.homedir;
	nodeOs.homedir = () => home;
	try {
		await fn();
	} finally {
		nodeOs.homedir = original;
	}
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	return c >>> 0;
});

function crc32(buffer: Buffer): number {
	let c = 0xffffffff;
	for (const byte of buffer) {
		c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typeAndData));
	return Buffer.concat([length, typeAndData, crc]);
}

/** A valid RGBA PNG of the given size (transparent pixels) */
export function makePng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // RGBA
	const rows = Buffer.alloc((width * 4 + 1) * height); // filter byte 0 + zeroed pixels per row
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', zlib.deflateSync(rows)),
		pngChunk('IEND', Buffer.alloc(0)),
	]);
}
