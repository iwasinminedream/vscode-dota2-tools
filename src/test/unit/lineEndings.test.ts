import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { parseEventDocument, parsePanelList } from '../../module/preProcessing';
import { eachLine } from '../../utils/eachLine';
import { getBaseInfo, readKeyValue2, readKeyValueWithBase, removeComment } from '../../utils/kvUtils';
import { crlf, lf, makeTempDir, removeDir, withEol, writeFile } from '../helpers';

/** The same text in both line-ending flavours: CRLF (Windows checkout) and LF (macOS/Linux checkout) */
const flavours = (text: string) => [['CRLF', crlf(text)], ['LF', lf(text)]] as const;

const ABILITIES = `"DOTAAbilities"
{
	// comment line
	"meepo_test_ability"
	{
		"BaseClass"	"ability_lua" // trailing comment
		"ScriptFile"	"abilities/meepo_test"
		"AbilityTextureName"	"meepo_poof"
		"Url"	"https://example.com/not//a//comment"
		"Note"	"first
second"
		"AbilityValues"
		{
			"damage"	"100 200 300"
		}
	}
}
`;

suite('line endings: CRLF and LF parse the same', () => {
	let root: string;
	setup(() => { root = makeTempDir('eol'); });
	teardown(() => removeDir(root));

	for (const [name, text] of flavours('a\nb\n\nc')) {
		test(`eachLine (${name}) yields lines without \\r`, () => {
			const lines: string[] = [];
			eachLine(text, (_i, line) => { lines.push(line); });
			assert.deepStrictEqual(lines, ['a', 'b', '', 'c']);
		});
	}

	for (const [host, eol] of [['Windows', '\r\n'], ['macOS/Linux', '\n']] as const) {
		test(`readKeyValue2 gives identical objects for CRLF and LF (os.EOL of ${host})`, () => withEol(eol, () => {
			const fromCrlf = readKeyValue2(crlf(ABILITIES));
			const fromLf = readKeyValue2(lf(ABILITIES));
			assert.deepStrictEqual(fromLf, fromCrlf);
			const ability = fromLf.DOTAAbilities.meepo_test_ability;
			assert.strictEqual(ability.BaseClass, 'ability_lua');
			assert.strictEqual(ability.Url, 'https://example.com/not//a//comment');
			assert.strictEqual(ability.Note, 'firstsecond');
			assert.strictEqual(ability.AbilityValues.damage, '100 200 300');
		}));
	}

	for (const [name, text] of flavours(ABILITIES)) {
		test(`removeComment (${name}) strips comments but keeps // inside quotes`, () => {
			const out = removeComment(text);
			assert.ok(!out.includes('comment line'));
			assert.ok(!out.includes('trailing comment'));
			assert.ok(out.includes('https://example.com/not//a//comment'));
			assert.ok(!out.includes('\r\r'));
		});
	}

	for (const [name, eol] of [['CRLF', '\r\n'], ['LF', '\n']] as const) {
		test(`#base (${name}): every base file is found and merged`, async () => {
			const main = writeFile(root, 'scripts/npc/npc_abilities_custom.txt',
				['#base "abilities/a.txt"', '#base "abilities/b.txt"', '"DOTAAbilities"', '{', '\t"main"\t"1"', '}', ''].join(eol));
			writeFile(root, 'scripts/npc/abilities/a.txt', ['"DOTAAbilities"', '{', '\t"from_a"\t"1"', '}', ''].join(eol));
			writeFile(root, 'scripts/npc/abilities/b.txt', ['"DOTAAbilities"', '{', '\t"from_b"\t"1"', '}', ''].join(eol));

			assert.deepStrictEqual(await getBaseInfo(main), ['abilities/a.txt', 'abilities/b.txt']);
			const merged = await readKeyValueWithBase(main);
			assert.deepStrictEqual(Object.keys(merged.DOTAAbilities).sort(), ['from_a', 'from_b', 'main']);
		});
	}

	for (const [name, text] of flavours('# Button\nbutton docs\n\n# Label\nlabel docs\n')) {
		test(`preProcessing.parsePanelList (${name}) gives clean panel names`, () => {
			writeFile(root, 'resource/PanelList.md', text);
			parsePanelList({ extensionPath: root } as any);
			const panels = JSON.parse(fs.readFileSync(path.join(root, 'resource', 'PanelList.json'), 'utf-8'));
			assert.deepStrictEqual(panels, { Button: { start: 0, end: 2 }, Label: { start: 3, end: 6 } });
		});
	}

	const EVENTS = '{| class="wikitable"\n! Event\n! Signature\n! Description\n|-\n| AddStyle\n| AddStyle( panel, class )\n| Add a class\n|}\n';
	for (const [name, text] of flavours(EVENTS)) {
		test(`preProcessing.parseEventDocument (${name}) builds markdown table rows`, () => {
			writeFile(root, 'resource/dump_panorama_events.txt', text);
			parseEventDocument({ extensionPath: root } as any);
			const md = fs.readFileSync(path.join(root, 'resource', 'dump_panorama_events.md'), 'utf-8');
			assert.ok(md.includes('AddStyle|AddStyle( panel, class )|Add a class'), md);
			assert.ok(!/\r\|/.test(md), 'a captured cell ends with \\r');
		});
	}
});
