/* Types for ensure-vrf.js (the unit tests import it) */

/** Download and extract the CLI for this platform into lib/vrf/ if missing; resolves to its path */
export function ensureVrf(): Promise<string>;

/** Path of the CLI for this platform in lib/vrf/ */
export const VRF_CLI: string;
export const VRF_DIR: string;

/** The CLI executable in the release archive: Source2Viewer-CLI.exe on Windows, Source2Viewer-CLI elsewhere */
export function vrfBinaryName(platform?: NodeJS.Platform): string;

/** Release asset of the CLI for a platform and CPU, e.g. cli-windows-x64.zip, cli-macos-arm64.zip; throws when there is none */
export function vrfAssetName(platform?: NodeJS.Platform, arch?: string): string;

/** Extract a zip into `dir` with what the system has (PowerShell / unzip / ditto / python3) */
export function extractZip(zip: string, dir: string, platform?: NodeJS.Platform): void;
