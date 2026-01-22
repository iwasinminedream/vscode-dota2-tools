import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
const execFileAsync = promisify(execFile);

function readUInt24LE(buffer: Buffer, offset: number): number {
	return buffer.readUIntLE(offset, 3);
}

function getImageSizeFallback(filePath: string): { width: number; height: number; } | undefined {
	const buffer = fs.readFileSync(filePath);

	// PNG
	if (buffer.length >= 24
		&& buffer[0] === 0x89
		&& buffer[1] === 0x50
		&& buffer[2] === 0x4E
		&& buffer[3] === 0x47
		&& buffer[4] === 0x0D
		&& buffer[5] === 0x0A
		&& buffer[6] === 0x1A
		&& buffer[7] === 0x0A) {
		const width = buffer.readUInt32BE(16);
		const height = buffer.readUInt32BE(20);
		if (width > 0 && height > 0) {
			return { width, height };
		}
	}

	// JPEG
	if (buffer.length >= 4 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
		let offset = 2;
		while (offset + 9 < buffer.length) {
			if (buffer[offset] !== 0xFF) {
				offset += 1;
				continue;
			}
			const marker = buffer[offset + 1];
			// SOF0, SOF1, SOF2, SOF3, SOF5, SOF6, SOF7, SOF9, SOF10, SOF11, SOF13, SOF14, SOF15
			if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(marker)) {
				const height = buffer.readUInt16BE(offset + 5);
				const width = buffer.readUInt16BE(offset + 7);
				if (width > 0 && height > 0) {
					return { width, height };
				}
				break;
			}
			if (marker === 0xDA || marker === 0xD9) {
				break;
			}
			const segmentLength = buffer.readUInt16BE(offset + 2);
			if (!segmentLength || segmentLength < 2) {
				break;
			}
			offset += 2 + segmentLength;
		}
	}

	// WEBP (VP8X / VP8L)
	if (buffer.length >= 30
		&& buffer.toString('ascii', 0, 4) === 'RIFF'
		&& buffer.toString('ascii', 8, 12) === 'WEBP') {
		const chunkType = buffer.toString('ascii', 12, 16);
		if (chunkType === 'VP8X' && buffer.length >= 30) {
			const width = 1 + readUInt24LE(buffer, 24);
			const height = 1 + readUInt24LE(buffer, 27);
			if (width > 0 && height > 0) {
				return { width, height };
			}
		}
		if (chunkType === 'VP8L' && buffer.length >= 25) {
			const b0 = buffer[20];
			if (b0 === 0x2F) {
				const b1 = buffer[21];
				const b2 = buffer[22];
				const b3 = buffer[23];
				const b4 = buffer[24];
				const width = 1 + (((b2 & 0x3F) << 8) | b1);
				const height = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6));
				if (width > 0 && height > 0) {
					return { width, height };
				}
			}
		}
	}

	return undefined;
}

function getImageSize(filePath: string): { width: number; height: number; } | undefined {
	try {
		return getImageSizeFallback(filePath);
	} catch {
		return undefined;
	}
}

async function readClipboardTextOrFileList(): Promise<string> {
	const text = await vscode.env.clipboard.readText();
	if (text.trim().length > 0) {
		return text;
	}

	if (process.platform !== 'win32') {
		return text;
	}

	try {
		const { stdout } = await execFileAsync('powershell.exe', [
			'-NoProfile',
			'-Command',
			'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'
		]);
		return typeof stdout === 'string' ? stdout : '';
	} catch {
		return text;
	}
}

function extractFilePathFromClipboard(raw: string): string | undefined {
	if (!raw) {
		return undefined;
	}

	const trimmed = raw.trim();
	if (!trimmed) {
		return undefined;
	}

	// file:// URI
	if (/^file:\/\//i.test(trimmed)) {
		try {
			const uri = vscode.Uri.parse(trimmed);
			return uri.fsPath;
		} catch {
			return undefined;
		}
	}

	// Extract first line if multiple
	const firstLine = trimmed.split(/\r?\n/)[0]?.trim();
	if (!firstLine) {
		return undefined;
	}

	// Remove surrounding quotes
	const unquoted = firstLine.replace(/^['"]|['"]$/g, '');

	// Windows absolute path
	const winMatch = unquoted.match(/([a-zA-Z]:[\\/][^\r\n"]+\.(png|jpg|jpeg|webp))/i);
	if (winMatch && winMatch[1]) {
		return winMatch[1];
	}

	// Fallback: if it's a plain path that exists
	if (path.isAbsolute(unquoted)) {
		return unquoted;
	}

	return undefined;
}

function toImagesUrl(filePath: string): string {
	const normalized = filePath.replace(/\\/g, '/');
	const lower = normalized.toLowerCase();
	const marker = '/panorama/images/';
	const index = lower.indexOf(marker);
	if (index >= 0) {
		const relative = normalized.slice(index + marker.length);
		return `file://{images}/${relative}`;
	}
	return vscode.Uri.file(filePath).toString();
}

function isImageFile(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return IMAGE_EXTENSIONS.includes(ext);
}

export async function pasteCssImageSnippet(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return;
	}

	const enabled = vscode.workspace
		.getConfiguration('dota2-tools')
		.get<boolean>('A10.less_image_paste.enabled', true);
	if (!enabled) {
		await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
		return;
	}

	if (editor.document.languageId !== 'less') {
		await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
		return;
	}

	const rawClipboard = await readClipboardTextOrFileList();
	const filePath = extractFilePathFromClipboard(rawClipboard);
	if (!filePath || !isImageFile(filePath) || !fs.existsSync(filePath)) {
		await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
		return;
	}

	const size = getImageSize(filePath);
	if (!size || !size.width || !size.height) {
		await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
		return;
	}

	const url = toImagesUrl(filePath);
	const lineText = editor.document.lineAt(editor.selection.active.line).text;
	const indent = lineText.match(/^\s*/)?.[0] ?? '';
	const snippetText =
		`${indent}width: ${size.width}px;\n` +
		`${indent}height: ${size.height}px;\n` +
		`${indent}background-image: url(\"${url}\");\n` +
		`${indent}background-size: 100%;`;

	await editor.insertSnippet(new vscode.SnippetString(snippetText));
}
