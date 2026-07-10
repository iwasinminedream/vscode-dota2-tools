import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { changeStatusBarState, getOutputChannel, refreshStatusBarMessage, showStatusBarMessage, StatusBarState } from "../module/statusBar";
import { localize } from "../utils/localize";

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

	changeStatusBarState(StatusBarState.LOADING);
	const fileName = path.basename(filePath);
	const messageIndex = showStatusBarMessage(localize("msg_compiling_resource", [fileName]), 120);
	execFile(compiler, ["-fshallow", "-i", filePath], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
		changeStatusBarState(StatusBarState.ALL_DONE);
		const output = getOutputChannel();
		output.appendLine(`> "${compiler}" -fshallow -i "${filePath}"`);
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
