import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { changeStatusBarState, getOutputChannel, refreshStatusBarMessage, showStatusBarMessage, StatusBarState } from "../module/statusBar";
import { localize } from "../utils/localize";

/**
 * Images have no direct compiler ("Failed to find compiler for file") — they compile
 * through a sibling <name>_<ext>.vtex descriptor, producing the <name>_<ext>.vtex_c
 * panorama expects. If the user has no hand-written .vtex, a temporary one is generated
 * (RGBA8888, no mips — mip generation fails on non-power-of-two panorama images).
 */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".tga", ".psd"]);

/** Path relative to the mod content root (content/<mod> or content/dota_addons/<addon>), '/'-separated */
function contentRelativePath(filePath: string): string | undefined {
	const parts = filePath.split(path.sep);
	const contentIndex = parts.findIndex((part) => part.toLowerCase() === "content");
	if (contentIndex === -1) {
		return undefined;
	}
	const modDepth = parts[contentIndex + 1]?.toLowerCase() === "dota_addons" ? contentIndex + 3 : contentIndex + 2;
	if (modDepth >= parts.length) {
		return undefined;
	}
	return parts.slice(modDepth).join("/");
}

function buildVtexDescriptor(contentRelativeImage: string): string {
	return `<!-- dmx encoding keyvalues2_noids 1 format vtex 1 -->
"CDmeVtex"
{
	"m_inputTextureArray" "element_array"
	[
		"CDmeInputTexture"
		{
			"m_name" "string" "InputTexture0"
			"m_fileName" "string" "${contentRelativeImage}"
			"m_colorSpace" "string" "srgb"
			"m_typeString" "string" "2D"
			"m_imageProcessorArray" "element_array"
			[
				"CDmeImageProcessor"
				{
					"m_algorithm" "string" "None"
					"m_stringArg" "string" ""
					"m_vFloat4Arg" "vector4" "0 0 0 0"
				}
			]
		}
	]
	"m_outputTypeString" "string" "2D"
	"m_outputFormat" "string" "RGBA8888"
	"m_outputClearColor" "vector4" "0 0 0 0"
	"m_nOutputMinDimension" "int" "0"
	"m_nOutputMaxDimension" "int" "0"
	"m_textureOutputChannelArray" "element_array"
	[
		"CDmeTextureOutputChannel"
		{
			"m_inputTextureArray" "string_array" [ "InputTexture0" ]
			"m_srcChannels" "string" "rgba"
			"m_dstChannels" "string" "rgba"
			"m_mipAlgorithm" "CDmeImageProcessor"
			{
				"m_algorithm" "string" "None"
				"m_stringArg" "string" ""
				"m_vFloat4Arg" "vector4" "0 0 0 0"
			}
			"m_outputColorSpace" "string" "srgb"
		}
	]
	"m_vClamp" "vector3" "0 0 0"
	"m_bNoLod" "bool" "1"
}
`;
}

/**
 * Locate resourcecompiler.exe: the configured Dota 2 install path first, then walk up
 * from the compiled file itself (the addon usually lives at <dota>/content/dota_addons/<addon>,
 * the compiler at <dota>/game/bin/win64).
 */
function findResourceCompiler(contentFilePath: string): string | undefined {
	const installPath = vscode.workspace.getConfiguration().get<string>("dota2-tools.dota2_install_path");
	if (installPath !== undefined && installPath !== "") {
		const compiler = path.join(installPath, "game", "bin", "win64", "resourcecompiler.exe");
		if (fs.existsSync(compiler)) {
			return compiler;
		}
	}
	const parts = contentFilePath.split(path.sep);
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i].toLowerCase() === "content") {
			const compiler = path.join(parts.slice(0, i).join(path.sep), "game", "bin", "win64", "resourcecompiler.exe");
			if (fs.existsSync(compiler)) {
				return compiler;
			}
		}
	}
	return undefined;
}

/** Recompile a content resource (explorer context menu on a file under content/) */
export async function recompileResource(context: vscode.ExtensionContext, uri?: vscode.Uri) {
	const fsPath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
	if (fsPath === undefined) {
		return;
	}
	// Resolve mklink junctions so the compiler sees the real path inside the Dota 2 installation
	let filePath = path.normalize(fsPath);
	try {
		filePath = fs.realpathSync.native(filePath);
	} catch {
		// keep the workspace path if it cannot be resolved
	}

	if (!/[\\/]content[\\/]/i.test(filePath)) {
		vscode.window.showWarningMessage(localize("msg_not_content_file", [filePath]));
		return;
	}

	const compiler = findResourceCompiler(filePath);
	if (compiler === undefined) {
		vscode.window.showErrorMessage(localize("msg_resourcecompiler_missing"));
		return;
	}

	// Images compile through a <name>_<ext>.vtex descriptor; keep a user-authored one, generate a temporary one otherwise
	let inputPath = filePath;
	let temporaryVtex: string | undefined;
	const ext = path.extname(filePath).toLowerCase();
	if (IMAGE_EXTENSIONS.has(ext)) {
		const vtexPath = filePath.slice(0, -ext.length) + `_${ext.slice(1)}.vtex`;
		if (!fs.existsSync(vtexPath)) {
			const relativeImage = contentRelativePath(filePath);
			if (relativeImage === undefined) {
				vscode.window.showWarningMessage(localize("msg_not_content_file", [filePath]));
				return;
			}
			try {
				fs.writeFileSync(vtexPath, buildVtexDescriptor(relativeImage));
			} catch (e) {
				vscode.window.showErrorMessage(localize("msg_compile_failed", [path.basename(filePath)]) + ` (${e})`);
				return;
			}
			temporaryVtex = vtexPath;
		}
		inputPath = vtexPath;
	}

	changeStatusBarState(StatusBarState.LOADING);
	const fileName = path.basename(filePath);
	const messageIndex = showStatusBarMessage(localize("msg_compiling_resource", [fileName]), 120);
	execFile(compiler, ["-fshallow", "-i", inputPath], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
		if (temporaryVtex !== undefined) {
			try {
				fs.unlinkSync(temporaryVtex);
			} catch {
				// leftover descriptor is harmless
			}
		}
		changeStatusBarState(StatusBarState.ALL_DONE);
		const output = getOutputChannel();
		output.appendLine(`> "${compiler}" -fshallow -i "${inputPath}"`);
		if (stdout) {
			output.append(stdout);
		}
		if (stderr) {
			output.append(stderr);
		}
		// resourcecompiler can exit with code 0 even when a resource fails, so also scan its output
		const failed = error !== null || /compile failed/i.test(`${stdout}${stderr}`);
		if (failed) {
			refreshStatusBarMessage(messageIndex, localize("msg_compile_failed", [fileName]));
			vscode.window.showErrorMessage(localize("msg_compile_failed", [fileName]), localize("dota2tools.showOutput")).then((choice) => {
				if (choice !== undefined) {
					output.show();
				}
			});
		} else {
			refreshStatusBarMessage(messageIndex, localize("msg_compile_done", [fileName]));
		}
	});
}
