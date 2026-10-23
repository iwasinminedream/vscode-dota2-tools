/**
 * sync-dota-data.js
 *
 * Reads parsed JSON files from the sibling dota-data project
 * and generates resource files for the VS Code extension's
 * inline hints, completions, and tree views.
 *
 * Also extracts images (spellicons, items, heroes, econ) from Dota 2 VPK
 * files using ValveResourceFormat CLI (Source2Viewer-CLI), on Windows, macOS and Linux.
 *
 * Usage:
 *   node scripts/sync-dota-data.js [path-to-dota-data]
 *
 * Default dota-data path: ../../dota/dota-data (relative to extension root)
 * Dota 2: the DOTA2_DIR environment variable, else the Steam libraries (libraryfolders.vdf);
 * without it the VPK steps are skipped.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureVrf, VRF_CLI } = require('./ensure-vrf');
const generators = require('./lib/dota-data-generators');
const { dotaVpk, findDota2 } = require('./lib/dota-install');

// ─── Configuration ───────────────────────────────────────────────────────────

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const RESOURCE_DIR = path.join(EXTENSION_ROOT, 'resource');
const IMAGES_DIR = path.join(EXTENSION_ROOT, 'images');

// Resolve dota-data path from CLI arg or default
const dotaDataPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(EXTENSION_ROOT, '../../dota/dota-data');

const FILES_DIR = path.join(dotaDataPath, 'files');

// VRF_CLI is imported from ensure-vrf.js

// Dota 2 VPK path — DOTA2_DIR or the Steam libraries
const DOTA2_DIR = findDota2() || null;
const DOTA_VPK = DOTA2_DIR ? dotaVpk(DOTA2_DIR) : null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readJson(filePath) {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    console.log(`  ✓ ${path.relative(EXTENSION_ROOT, filePath)}`);
}

function writeText(filePath, text) {
    fs.writeFileSync(filePath, text, 'utf-8');
    console.log(`  ✓ ${path.relative(EXTENSION_ROOT, filePath)}`);
}

// ─── 1–5. dota-data JSON → resource files ───────────────────────────────────
// The conversions live in lib/dota-data-generators.js: the extension runs the same code when it
// downloads a newer dota-data from GitHub (src/utils/dotaDataStore.ts).

function generateLuaApiJson() {
    console.log('\n[1/6] Generating dota_script_help2.json ...');
    const api = readJson(path.join(FILES_DIR, 'vscripts', 'api.json'));
    const enums = readJson(path.join(FILES_DIR, 'vscripts', 'enums.json'));
    writeJson(path.join(RESOURCE_DIR, 'dota_script_help2.json'), generators.luaApiJson(api, enums));
}

function generateLuaDumpFiles() {
    console.log('\n[2/6] Generating dota_script_help2.lua + dota_cl_script_help2.lua ...');
    const api = readJson(path.join(FILES_DIR, 'vscripts', 'api.json'));
    const enums = readJson(path.join(FILES_DIR, 'vscripts', 'enums.json'));
    const { server, client } = generators.luaDumps(api, enums);
    writeText(path.join(RESOURCE_DIR, 'dota_script_help2.lua'), server);
    writeText(path.join(RESOURCE_DIR, 'dota_cl_script_help2.lua'), client);
}

function generatePanoramaApiJson() {
    console.log('\n[3/6] Generating cl_panorama_script_help_2.json + cl_panorama_script_help_2.txt ...');
    const api = readJson(path.join(FILES_DIR, 'panorama', 'api.json'));
    const enums = readJson(path.join(FILES_DIR, 'panorama', 'enums.json'));
    const { json, txt } = generators.panoramaApi(api, enums);
    writeJson(path.join(RESOURCE_DIR, 'cl_panorama_script_help_2.json'), json);
    writeText(path.join(RESOURCE_DIR, 'cl_panorama_script_help_2.txt'), txt);
}

function generatePanoramaCssJson() {
    console.log('\n[4/6] Generating dump_panorama_css_properties.json ...');
    const css = readJson(path.join(FILES_DIR, 'panorama', 'css.json'));
    writeJson(path.join(RESOURCE_DIR, 'dump_panorama_css_properties.json'), generators.panoramaCss(css));
}

function generatePanoramaEvents() {
    console.log('\n[5/6] Generating dump_panorama_events.md + dump_panorama_events.txt ...');
    const events = readJson(path.join(FILES_DIR, 'panorama', 'events.json'));
    const { md, txt } = generators.panoramaEvents(events);
    writeText(path.join(RESOURCE_DIR, 'dump_panorama_events.md'), md);
    writeText(path.join(RESOURCE_DIR, 'dump_panorama_events.txt'), txt);
}

// ─── 6. PanelList — SKIPPED (hand-maintained) ───────────────────────────────
// PanelList.json and PanelList.md are hand-maintained with Chinese descriptions
// and panel attribute information that dota-data doesn't contain.
// They are NOT regenerated automatically.

// ─── 6b. VPK Text Files (npc/*, items_game.txt) ────────────────────────────

function extractVpkTextFiles() {
    console.log('\n[6b] Extracting npc files and items_game.txt from VPK ...');

    if (!DOTA_VPK) {
        console.warn('  ⚠ Dota 2 installation not found (set DOTA2_DIR). Skipping VPK text extraction.');
        return;
    }

    const tmpDir = path.join(EXTENSION_ROOT, '.vpk_text_tmp');
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });

    // Extract scripts/npc/ and scripts/items/items_game.txt
    const filters = ['scripts/npc/', 'scripts/items/items_game.txt'];

    for (const filter of filters) {
        try {
            execFileSync(VRF_CLI, [
                '-i', DOTA_VPK,
                '-o', tmpDir,
                '-f', filter,
            ], { stdio: 'ignore', timeout: 60000 });
        } catch (err) {
            console.error(`  ✗ VRF extraction failed for ${filter}:`, err.message);
        }
    }

    // Copy npc files
    const npcSrc = path.join(tmpDir, 'scripts', 'npc');
    const npcDest = path.join(RESOURCE_DIR, 'npc');
    if (fs.existsSync(npcSrc)) {
        const count = copyTextFilesRecursive(npcSrc, npcDest);
        console.log(`  ✓ npc: ${count} files updated`);
    } else {
        console.warn('  ⚠ No npc files extracted');
    }

    // Copy items_game.txt
    const itemsSrc = path.join(tmpDir, 'scripts', 'items', 'items_game.txt');
    if (fs.existsSync(itemsSrc)) {
        fs.copyFileSync(itemsSrc, path.join(RESOURCE_DIR, 'items_game.txt'));
        console.log('  ✓ items_game.txt updated');
    } else {
        console.warn('  ⚠ items_game.txt not extracted');
    }

    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
}

/** Recursively copy text files, overwriting existing, returns count */
function copyTextFilesRecursive(src, dest) {
    let count = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            count += copyTextFilesRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
}

// ─── 7. VPK Image Extraction ────────────────────────────────────────────────

const { spawn } = require('child_process');

/**
 * Run VRF CLI and return a promise. Uses spawn with stdio:'ignore' to avoid ENOBUFS.
 */
function runVrf(args) {
    return new Promise((resolve) => {
        const proc = spawn(VRF_CLI, args, { stdio: 'ignore', timeout: 600000 });
        proc.on('close', () => resolve());
        proc.on('error', () => resolve());
    });
}

/**
 * List files in VPK matching a filter (returns array of relative paths).
 */
function listVpkFiles(vpkFilter) {
    const out = execFileSync(VRF_CLI, [
        '-i', DOTA_VPK,
        '-l',
        '-f', vpkFilter,
        '-e', 'vtex_c',
    ], { timeout: 30000, maxBuffer: 50 * 1024 * 1024 }).toString();
    return out.split('\n')
        .map(line => line.trim().split(' ')[0])
        .filter(f => f.endsWith('.vtex_c'));
}

/**
 * Build a set of existing .png filenames (without path) in a directory, recursively.
 */
function collectExistingPngs(dir) {
    const existing = new Set();
    if (!fs.existsSync(dir)) return existing;
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            if (entry.isDirectory()) walk(path.join(d, entry.name));
            else if (entry.name.endsWith('.png')) existing.add(entry.name);
        }
    };
    walk(dir);
    return existing;
}

/**
 * Build a set of existing .png relative paths in a directory, recursively.
 */
function collectExistingPngsRelative(dir) {
    const existing = new Set();
    if (!fs.existsSync(dir)) return existing;
    const walk = (d, rel) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const relPath = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) walk(path.join(d, entry.name), relPath);
            else if (entry.name.endsWith('.png')) existing.add(relPath);
        }
    };
    walk(dir, '');
    return existing;
}

/**
 * Extract images from Dota 2 VPK using ValveResourceFormat CLI.
 * Only extracts new images that don't already exist in the target directory.
 * econ_items is split into sub-filters and extracted in parallel to avoid ENOBUFS.
 */
async function extractVpkImages() {
    console.log('\n[7/7] Extracting images from Dota 2 VPK ...');

    if (!DOTA_VPK) {
        console.warn('  ⚠ Dota 2 installation not found (set DOTA2_DIR). Skipping image extraction.');
        return;
    }

    console.log(`  VRF CLI:  ${VRF_CLI}`);
    console.log(`  Dota VPK: ${DOTA_VPK}`);

    const tmpDir = path.join(EXTENSION_ROOT, '.vpk_extract_tmp');

    // --- Small tasks (spellicons, items, heroes) run synchronously ---
    const smallTasks = [
        {
            name: 'spellicons',
            vpkFilter: 'panorama/images/spellicons/',
            targetDir: path.join(IMAGES_DIR, 'spellicons'),
            flat: true,
        },
        {
            name: 'items',
            vpkFilter: 'panorama/images/items/',
            targetDir: path.join(IMAGES_DIR, 'items'),
            flat: true,
        },
        {
            name: 'heroes_icon',
            vpkFilter: 'panorama/images/heroes/icons/',
            targetDir: path.join(IMAGES_DIR, 'heroes_icon'),
            flat: true,
        },
    ];

    for (const task of smallTasks) {
        extractTask(task, tmpDir);
    }

    // --- econ_items: split into sub-filters, extract in parallel ---
    const econSubFilters = [
        'panorama/images/econ/heroes/',
        'panorama/images/econ/items/',
        'panorama/images/econ/loading_screens/',
        'panorama/images/econ/sets/',
    ];
    await extractEconParallel(econSubFilters, tmpDir);

    // Cleanup tmp
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
}

function extractTask(task, tmpDir) {
    console.log(`\n  Extracting ${task.name} ...`);

    // Collect existing files to skip
    const existing = task.flat
        ? collectExistingPngs(task.targetDir)
        : collectExistingPngsRelative(task.targetDir);

    // List what's in the VPK
    let vpkFiles;
    try {
        vpkFiles = listVpkFiles(task.vpkFilter);
    } catch (err) {
        console.error(`  ✗ Failed to list VPK for ${task.name}:`, err.message);
        return;
    }

    // Determine which files are new
    const newFiles = vpkFiles.filter(f => {
        const pngName = path.basename(f).replace('.vtex_c', '.png');
        if (task.flat) {
            return !existing.has(pngName);
        } else {
            // Relative path from the vpkFilter root
            const rel = f.replace(task.vpkFilter, '').replace('.vtex_c', '.png');
            return !existing.has(rel);
        }
    });

    if (newFiles.length === 0) {
        console.log(`  ✓ ${task.name}: up to date (${vpkFiles.length} images, 0 new)`);
        return;
    }

    console.log(`    ${vpkFiles.length} total, ${newFiles.length} new`);

    // Clean & create tmp dir for this task
    const taskTmp = path.join(tmpDir, task.name);
    if (fs.existsSync(taskTmp)) fs.rmSync(taskTmp, { recursive: true });
    fs.mkdirSync(taskTmp, { recursive: true });

    try {
        execFileSync(VRF_CLI, [
            '-i', DOTA_VPK,
            '-o', taskTmp,
            '-d',
            '-f', task.vpkFilter,
            '--threads', '8',
        ], { stdio: 'ignore', timeout: 600000 });
    } catch (err) {
        console.error(`  ✗ VRF extraction failed for ${task.name}:`, err.message);
        return;
    }

    const extractedRoot = path.join(taskTmp, ...task.vpkFilter.split('/').filter(Boolean));
    if (!fs.existsSync(extractedRoot)) {
        console.warn(`  ⚠ No files extracted for ${task.name}`);
        return;
    }

    fs.mkdirSync(task.targetDir, { recursive: true });

    let count = 0;
    if (task.flat) {
        const pngs = collectPngsFlat(extractedRoot);
        for (const src of pngs) {
            const name = path.basename(src);
            if (existing.has(name)) continue;
            fs.copyFileSync(src, path.join(task.targetDir, name));
            count++;
        }
    } else {
        count = copyNewFiles(extractedRoot, task.targetDir, existing, '');
    }

    console.log(`  ✓ ${task.name}: ${count} new images extracted`);
}

/**
 * Extract econ sub-categories in parallel (4 VRF processes).
 */
async function extractEconParallel(subFilters, tmpDir) {
    console.log(`\n  Extracting econ_items (${subFilters.length} categories in parallel) ...`);

    const econTargetBase = path.join(IMAGES_DIR, 'econ_items', 'econ');
    const existing = collectExistingPngsRelative(econTargetBase);
    console.log(`    ${existing.size} existing images`);

    // Launch VRF processes in parallel
    const promises = subFilters.map((filter) => {
        const categoryName = filter.split('/').filter(Boolean).pop();
        const taskTmp = path.join(tmpDir, `econ_${categoryName}`);
        if (fs.existsSync(taskTmp)) fs.rmSync(taskTmp, { recursive: true });
        fs.mkdirSync(taskTmp, { recursive: true });

        console.log(`    Starting: ${categoryName}`);

        return runVrf([
            '-i', DOTA_VPK,
            '-o', taskTmp,
            '-d',
            '-f', filter,
            '--threads', '4',
        ]).then(() => {
            // Copy new files from extracted tmp to target
            const extractedRoot = path.join(taskTmp, 'panorama', 'images', 'econ', categoryName);
            const targetDir = path.join(econTargetBase, categoryName);

            if (!fs.existsSync(extractedRoot)) {
                console.warn(`    ⚠ No files for ${categoryName}`);
                return 0;
            }

            fs.mkdirSync(targetDir, { recursive: true });
            const count = copyNewFiles(extractedRoot, targetDir, existing, categoryName);
            console.log(`    ✓ ${categoryName}: ${count} new images`);
            return count;
        });
    });

    const counts = await Promise.all(promises);
    const total = counts.reduce((a, b) => a + b, 0);
    console.log(`  ✓ econ_items: ${total} new images total`);
}

/** Recursively collect all .png file paths (flat list) */
function collectPngsFlat(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) results.push(...collectPngsFlat(full));
        else if (entry.name.endsWith('.png')) results.push(full);
    }
    return results;
}

/** Recursively copy only files not in the existing set, returns count */
function copyNewFiles(src, dest, existing, relPrefix) {
    let count = 0;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            count += copyNewFiles(srcPath, destPath, existing, rel);
        } else if (entry.name.endsWith('.png') && !existing.has(rel)) {
            fs.copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== sync-dota-data ===');
    console.log(`dota-data path: ${dotaDataPath}`);
    console.log(`resource dir:   ${RESOURCE_DIR}`);

    // Ensure VRF CLI is available for the VPK steps (downloads if needed)
    if (DOTA_VPK) {
        await ensureVrf();
    }

    // Validate dota-data exists
    if (!fs.existsSync(FILES_DIR)) {
        console.error(`\nERROR: dota-data files directory not found at: ${FILES_DIR}`);
        console.error('Please provide the correct path: node scripts/sync-dota-data.js <path-to-dota-data>');
        process.exit(1);
    }

    // Validate required files
    const requiredFiles = [
        'vscripts/api.json',
        'vscripts/enums.json',
        'panorama/api.json',
        'panorama/css.json',
        'panorama/enums.json',
        'panorama/events.json',
    ];

    for (const file of requiredFiles) {
        const filePath = path.join(FILES_DIR, file);
        if (!fs.existsSync(filePath)) {
            console.error(`\nERROR: Required file not found: ${filePath}`);
            console.error('Ensure dota-data has been built: cd dota-data && npm run build:static');
            process.exit(1);
        }
    }

    // Run all generators
    generateLuaApiJson();
    generateLuaDumpFiles();
    generatePanoramaApiJson();
    generatePanoramaCssJson();
    generatePanoramaEvents();
    // PanelList.json + PanelList.md are hand-maintained — not overwritten

    // Extract text files from VPK (npc/*, items_game.txt)
    extractVpkTextFiles();

    // Extract images from VPK
    await extractVpkImages();

    console.log('\n=== Done! All resource files updated. ===');
    console.log('Note: PanelList.json and PanelList.md are hand-maintained and NOT overwritten.');
    console.log('Note: api_note.json is maintained via MySQL and NOT overwritten.');
}

main();
