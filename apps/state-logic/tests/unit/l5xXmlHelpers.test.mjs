// L5X serialisation helpers exported by src/lib/l5xExporter.js. The module is
// large but has no load-time side effects (download/DOM work lives inside functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeXml,
  cdata,
  buildRung,
  buildBoolTagXml,
  buildTimerTagXml,
  buildDintTagXml,
  STEP_BASE,
  STEP_INCREMENT,
  RESERVED_STATE_NUMBERS,
} from '../../src/lib/l5xExporter.js';

test('escapeXml escapes the four XML-significant characters and tolerates null', () => {
  assert.equal(escapeXml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;');
  assert.equal(escapeXml(null), '');
  assert.equal(escapeXml(undefined), '');
  assert.equal(escapeXml(42), '42');
});

test('cdata wraps verbatim', () => {
  assert.equal(cdata('XIC(i_A) OTE(q_B);'), '<![CDATA[XIC(i_A) OTE(q_B);]]>');
});

test('buildRung emits Comment only when a comment is given', () => {
  const withComment = buildRung(3, 'Step 4', 'NOP();');
  assert.match(withComment, /<Rung Number="3" Type="N">/);
  assert.match(withComment, /<Comment>\n<!\[CDATA\[Step 4\]\]>\n<\/Comment>/);
  assert.match(withComment, /<Text>\n<!\[CDATA\[NOP\(\);\]\]>\n<\/Text>/);
  assert.ok(withComment.trimEnd().endsWith('</Rung>'));

  const bare = buildRung(0, '', 'NOP();');
  assert.ok(!bare.includes('<Comment>'));
});

test('tag builders emit the right DataType and default values', () => {
  const b = buildBoolTagXml('q_ExtendStampCyl', 'Extend solenoid', 'Output', 'Read Only');
  assert.match(b, /<Tag Name="q_ExtendStampCyl" TagType="Base" DataType="BOOL"/);
  assert.match(b, /ExternalAccess="Read Only"/);
  assert.match(b, /<!\[CDATA\[Extend solenoid\]\]>/);

  const t = buildTimerTagXml('StampCylExtendDelay', 'delay', 750);
  assert.match(t, /DataType="TIMER"/);
  assert.match(t, /<!\[CDATA\[\[0,750,0\]\]\]>/);
  assert.match(t, /Name="PRE" DataType="DINT" Radix="Decimal" Value="750"/);

  const d = buildDintTagXml('Counter', 'count', 12);
  assert.match(d, /DataType="DINT"/);
  assert.match(d, /<DataValue DataType="DINT" Radix="Decimal" Value="12"\/>/);
});

test('SDC step-grid constants match the standard', () => {
  assert.equal(STEP_BASE, 1);
  assert.equal(STEP_INCREMENT, 3);
  assert.deepEqual([...RESERVED_STATE_NUMBERS].sort((a, b) => a - b), [0, 1, 2, 3, 99]);
});
