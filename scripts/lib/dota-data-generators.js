/**
 * dota-data-generators.js
 *
 * Turns the parsed JSON of @moddota/dota-data (files/) into the extension's resource files.
 * Pure functions: parsed JSON in, file contents out. Used by scripts/sync-dota-data.js (the
 * bundled resource/ copies) and by the extension itself (src/utils/dotaDataStore.ts), which
 * regenerates them whenever dota-data on GitHub gets a new dump.
 */

// ─── VScripts API → dota_script_help2.json ──────────────────────────────────

/** files/vscripts/api.json + enums.json → { class_list, enum_list } (dota_script_help2.json) */
function luaApiJson(api, enums) {
    const class_list = {};
    const enum_list = {};

    // Process classes and their members
    for (const decl of api) {
        if (decl.kind === 'class') {
            const className = decl.name;
            const clientClassName = decl.clientName || undefined;
            if (!class_list[className]) class_list[className] = [];

            for (const member of (decl.members || [])) {
                if (member.kind === 'function') {
                    const func = convertVScriptFunction(member, className, clientClassName);
                    class_list[className].push(func);
                }
            }
        } else if (decl.kind === 'function') {
            // Standalone global function
            if (!class_list['Global']) class_list['Global'] = [];
            const func = convertVScriptFunction(decl, 'Global', undefined);

            // Mark client availability from the clientName / available field
            if (decl.available === 'both' || decl.available === 'client') {
                func.class_cl = 'Global';
            }

            class_list['Global'].push(func);
        }
    }

    // Process enums and constants
    for (const decl of enums) {
        if (decl.kind === 'enum') {
            const enumName = decl.name;
            if (!enum_list[enumName]) enum_list[enumName] = [];

            for (const member of (decl.members || [])) {
                enum_list[enumName].push({
                    name: member.name,
                    class: enumName,
                    value: member.value,
                    function: member.description || '',
                    description_lite: '',
                    description: '',
                    example: ''
                });
            }
        } else if (decl.kind === 'constant') {
            // Constants go into a "Constants" enum group
            if (!enum_list['Constants']) enum_list['Constants'] = [];
            enum_list['Constants'].push({
                name: decl.name,
                class: 'Constants',
                value: decl.value,
                function: '',
                description_lite: '',
                description: '',
                example: ''
            });
        }
    }

    return { class_list, enum_list };
}

function convertVScriptFunction(member, className, clientClassName) {
    const params = {};
    if (member.args) {
        member.args.forEach((arg, index) => {
            const type = (arg.types && arg.types[0]) || 'handle';
            const key = `${type}_${index + 1}`;
            params[key] = {
                type: type,
                params_name: arg.name || `${type}_${index + 1}`,
                description: arg.description || 'No Description Set'
            };
        });
    }

    const returnType = (member.returns && member.returns.length > 0)
        ? member.returns.join(' | ')
        : 'void';

    const isServer = member.available === 'server' || member.available === 'both';
    const isClient = member.available === 'client' || member.available === 'both';

    const func = {
        description: member.description || '',
        return: returnType,
        function: member.name,
        class: className,
        params,
        server: isServer,
        client: isClient
    };

    // Add clientName if available on client
    if (isClient && clientClassName) {
        func.class_cl = clientClassName;
    }

    return func;
}

// ─── VScripts API → .lua dump files ─────────────────────────────────────────

/** files/vscripts/api.json + enums.json → { server, client }: dota_script_help2.lua, dota_cl_script_help2.lua */
function luaDumps(api, enums) {
    const serverLines = [];
    const clientLines = [];

    // Process global functions first (matches original file order)
    for (const decl of api) {
        if (decl.kind === 'function') {
            const luaBlock = formatLuaFunction(decl, null);

            if (decl.available === 'server' || decl.available === 'both') {
                serverLines.push(luaBlock);
            }
            if (decl.available === 'client' || decl.available === 'both') {
                clientLines.push(luaBlock);
            }
        }
    }

    // Then process classes
    for (const decl of api) {
        if (decl.kind === 'class') {
            const className = decl.name;
            const clientClassName = decl.clientName || className;

            for (const member of (decl.members || [])) {
                if (member.kind === 'function') {
                    const luaBlock = formatLuaFunction(member, className);
                    const luaBlockClient = formatLuaFunction(member, clientClassName);

                    if (member.available === 'server' || member.available === 'both') {
                        serverLines.push(luaBlock);
                    }
                    if (member.available === 'client' || member.available === 'both') {
                        clientLines.push(luaBlockClient);
                    }
                }
            }
        }
    }

    // Process enums
    for (const decl of enums) {
        if (decl.kind === 'enum') {
            const enumBlock = formatLuaEnum(decl);
            // Enums go into both server and client
            if (decl.available === 'server' || decl.available === 'both') {
                serverLines.push(enumBlock);
            }
            if (decl.available === 'client' || decl.available === 'both') {
                clientLines.push(enumBlock);
            }
        } else if (decl.kind === 'constant') {
            const constLine = formatLuaConstant(decl);
            if (decl.available === 'server' || decl.available === 'both') {
                serverLines.push(constLine);
            }
            if (decl.available === 'client' || decl.available === 'both') {
                clientLines.push(constLine);
            }
        }
    }

    return { server: serverLines.join('\n'), client: clientLines.join('\n') };
}

function formatLuaFunction(member, className) {
    const args = (member.args || []);
    const paramNames = args.map(a => a.name || 'unknown');
    const paramStr = paramNames.join(', ');

    const desc = member.description || '';
    const returnType = (member.returns && member.returns.length > 0) ? member.returns[0] : 'void';

    const lines = [];
    lines.push(`---[[ ${member.name}  ${desc} ]]`);
    lines.push(`-- @return ${returnType}`);

    for (const arg of args) {
        const type = (arg.types && arg.types[0]) || 'handle';
        lines.push(`-- @param ${arg.name || 'unknown'} ${type}`);
    }

    if (className) {
        lines.push(`function ${className}:${member.name}( ${paramStr} ) end`);
    } else {
        lines.push(`function ${member.name}( ${paramStr} ) end`);
    }

    lines.push('');
    return lines.join('\n');
}

function formatLuaEnum(decl) {
    const lines = [];
    lines.push(`--- Enum ${decl.name}`);
    for (const member of (decl.members || [])) {
        lines.push(`${member.name} = ${member.value}`);
    }
    lines.push('');
    return lines.join('\n');
}

function formatLuaConstant(decl) {
    return `--- Enum Constants\n${decl.name} = ${decl.value}\n`;
}

// ─── Panorama API → cl_panorama_script_help_2.json + .txt ───────────────────

/** files/panorama/api.json + enums.json → { json, txt }: cl_panorama_script_help_2.json and .txt */
function panoramaApi(api, enums) {
    const result = {};
    const txtLines = [];

    // Process interfaces (classes)
    for (const iface of api) {
        const className = iface.name;
        result[className] = {};

        // Build the instance name (short name used in Signature) from the className
        // e.g. CPanoramaScript_GameEvents → GameEvents
        //      CScriptBindingPR_Buffs → Buffs
        //      $ stays as $
        const instanceName = getJsInstanceName(className);

        txtLines.push(`=== ${className} ===`);
        txtLines.push('{| class="standard-table" style="width: 100%;"');
        txtLines.push('! Function');
        txtLines.push('! Signature');
        txtLines.push('! Description');

        for (const member of (iface.members || [])) {
            const funcName = member.name;
            const args = (member.args || []).map(a => {
                const type = a.type || 'js_value';
                return `${type} ${a.name}`;
            }).join(', ');

            const signature = `${instanceName}.${funcName}( ${args} )`;

            result[className][funcName] = {
                Function: funcName,
                Signature: signature,
                Description: member.description || ''
            };

            txtLines.push('|- ');
            txtLines.push(`| ${funcName}`);
            txtLines.push(`| <code>${signature}</code>`);
            txtLines.push(`| ${member.description || ''}`);
        }

        txtLines.push('|}');
        txtLines.push('');
        txtLines.push('');
    }

    // Process enums
    for (const enumDecl of enums) {
        const enumName = enumDecl.name;
        result[enumName] = {};

        txtLines.push(`=== ${enumName} ===`);
        txtLines.push('{| class="standard-table" style="width: 100%;"');
        txtLines.push('! Enumerator');
        txtLines.push('! Value');
        txtLines.push('! Description');

        for (const member of (enumDecl.members || [])) {
            const fullName = `${enumName}.${member.name}`;

            result[enumName][fullName] = {
                Enumerator: fullName,
                Value: String(member.value),
                Description: ''
            };

            txtLines.push('|- ');
            txtLines.push(`| ${fullName}`);
            txtLines.push(`| ${member.value}`);
            txtLines.push('| ');
        }

        txtLines.push('|}');
        txtLines.push('');
        txtLines.push('');
    }

    return { json: result, txt: txtLines.join('\n') };
}

function getJsInstanceName(className) {
    // Special cases
    if (className === '$') return '$';
    if (className === 'Panel') return 'Panel';

    // CPanoramaScript_GameEvents → GameEvents
    // CScriptBindingPR_Buffs → Buffs
    // CDOTA_PanoramaScript_GameUI → GameUI
    let name = className;

    // Strip common prefixes
    const prefixes = [
        'CPanoramaScript_',
        'CScriptBindingPR_',
        'CDOTA_PanoramaScript_',
        'CDOTAPanoramaScript_',
    ];

    for (const prefix of prefixes) {
        if (name.startsWith(prefix)) {
            name = name.substring(prefix.length);
            break;
        }
    }

    return name;
}

// ─── Panorama CSS → dump_panorama_css_properties.json ───────────────────────

/** files/panorama/css.json → dump_panorama_css_properties.json */
function panoramaCss(css) {
    const result = {};

    for (const [propName, propData] of Object.entries(css)) {
        result[propName] = {
            description: propData.description || '<Needs a description>'
        };
        if (propData.examples && propData.examples.length > 0) {
            result[propName].example = propData.examples.join('\r\n');
        }
    }

    return result;
}

// ─── Panorama Events → dump_panorama_events.md + .txt ───────────────────────

/** files/panorama/events.json → { md, txt }: dump_panorama_events.md and .txt */
function panoramaEvents(events) {
    const mdLines = [];
    const txtLines = [];

    // Markdown table header
    mdLines.push('Event|Panel Event|Panel Event');
    mdLines.push('--|--|--');

    // Wiki table header (txt)
    txtLines.push('{| class="wikitable"');
    txtLines.push('! Event');
    txtLines.push('! Panel Event');
    txtLines.push('! Description');

    for (const [eventName, eventData] of Object.entries(events)) {
        const argsStr = (eventData.args || []).map(a => `${a.type} ${a.name}`).join(', ');
        const signature = `${eventName}(${argsStr})`;
        const isPanelEvent = eventData.panelEvent ? 'Yes' : 'No';
        const desc = eventData.description || '';

        // Markdown row
        mdLines.push(`<code>${signature}</code>|${isPanelEvent}|${desc}`);

        // Wiki table row (txt)
        txtLines.push('|-');
        txtLines.push(`| <code>${signature}</code>`);
        txtLines.push(`| ${isPanelEvent}`);
        txtLines.push(`| ${desc}`);
    }

    txtLines.push('|}');

    return { md: mdLines.join('\n'), txt: txtLines.join('\n') };
}

module.exports = { luaApiJson, luaDumps, panoramaApi, panoramaCss, panoramaEvents };
