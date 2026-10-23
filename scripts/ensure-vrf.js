/**
 * ensure-vrf.js
 *
 * Downloads and extracts ValveResourceFormat CLI (Source2Viewer-CLI) for this platform —
 * Windows, macOS or Linux, x64 or arm64 — if not already present in lib/vrf/.
 * Used by sync-dota-data.js and extract-images.js.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const VRF_DIR = path.join(path.resolve(__dirname, '..'), 'lib', 'vrf');
const VRF_CLI = path.join(VRF_DIR, vrfBinaryName());
const VRF_ZIP = path.join(VRF_DIR, 'cli.zip');

const VRF_RELEASE_URL = 'https://api.github.com/repos/ValveResourceFormat/ValveResourceFormat/releases/latest';

/** The CLI executable in the release archive: Source2Viewer-CLI.exe on Windows, Source2Viewer-CLI elsewhere */
function vrfBinaryName(platform = process.platform) {
    return platform === 'win32' ? 'Source2Viewer-CLI.exe' : 'Source2Viewer-CLI';
}

/** Release asset of the CLI for a platform and CPU, e.g. cli-windows-x64.zip, cli-macos-arm64.zip */
function vrfAssetName(platform = process.platform, arch = process.arch) {
    const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform];
    if (!os || !['x64', 'arm64'].includes(arch)) {
        throw new Error(`ValveResourceFormat CLI has no build for ${platform}-${arch}`);
    }
    return `cli-${os}-${arch}.zip`;
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const opts = { headers: { 'User-Agent': 'dota2tools' } };
        https.get(url, opts, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Extract a zip into `dir` with what the system has: PowerShell on Windows; unzip, ditto (macOS)
 * or Python elsewhere. Executables keep (or get back) their exec bit.
 */
function extractZip(zip, dir, platform = process.platform) {
    if (platform === 'win32') {
        execFileSync('powershell', [
            '-NoProfile', '-Command',
            `Expand-Archive -Force -Path '${zip}' -DestinationPath '${dir}'`
        ], { stdio: 'pipe', timeout: 60000 });
        return;
    }
    const tools = [
        ['unzip', ['-o', '-q', zip, '-d', dir]],
        ...(platform === 'darwin' ? [['ditto', ['-x', '-k', zip, dir]]] : []),
        ['python3', ['-m', 'zipfile', '-e', zip, dir]],
    ];
    for (const [tool, args] of tools) {
        try {
            execFileSync(tool, args, { stdio: 'pipe', timeout: 120000 });
            return;
        } catch {
            // not installed or failed: the next one
        }
    }
    throw new Error(`Could not extract ${zip}: install unzip (or python3) and run again`);
}

async function ensureVrf() {
    if (fs.existsSync(VRF_CLI)) return VRF_CLI;

    console.log('  VRF CLI not found. Downloading...');
    fs.mkdirSync(VRF_DIR, { recursive: true });

    // Get latest release info
    const assetName = vrfAssetName();
    const releaseJson = await httpsGet(VRF_RELEASE_URL);
    const release = JSON.parse(releaseJson.toString());
    const asset = release.assets.find(a => a.name === assetName);
    if (!asset) throw new Error(`Could not find ${assetName} in the latest ValveResourceFormat release`);

    console.log(`  Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);
    const zipData = await httpsGet(asset.browser_download_url);
    fs.writeFileSync(VRF_ZIP, zipData);

    console.log('  Extracting...');
    extractZip(VRF_ZIP, VRF_DIR);

    // Cleanup zip
    fs.unlinkSync(VRF_ZIP);

    if (!fs.existsSync(VRF_CLI)) {
        throw new Error(`Extraction succeeded but ${VRF_CLI} not found`);
    }
    // Python's zipfile drops the exec bit
    if (process.platform !== 'win32') fs.chmodSync(VRF_CLI, 0o755);

    console.log('  VRF CLI ready.');
    return VRF_CLI;
}

module.exports = { ensureVrf, VRF_CLI, VRF_DIR, vrfBinaryName, vrfAssetName, extractZip };
