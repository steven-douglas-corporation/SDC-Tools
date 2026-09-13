// Post-generation L5X validation (src/lib/agentGenerator/validator.js). CommonJS
// module; Node exposes module.exports as the default import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import validator from '../../src/lib/agentGenerator/validator.js';

const { validateL5X, isLegalState, formatReport } = validator;

test('isLegalState accepts the SDC grid, reserved states and the init block', () => {
  for (const n of [0, 1, 2, 3, 4, 7, 10, 97, 99, 100, 124, 127]) assert.ok(isLegalState(n), `${n} should be legal`);
  // Off-grid but inside the sequence range is a warning, not illegal.
  assert.ok(isLegalState(5));
  for (const n of [-1, 98, 128, 500]) assert.ok(!isLegalState(n), `${n} should be illegal`);
});

test('validateL5X rejects empty, malformed and non-L5X documents', () => {
  assert.deepEqual(validateL5X(''), { ok: false, errors: ['Empty document'], warnings: [] });
  assert.equal(validateL5X(null).ok, false);

  const malformed = validateL5X('<RSLogix5000Content><Controller></RSLogix5000Content>');
  assert.equal(malformed.ok, false);
  assert.match(malformed.errors[0], /not well-formed/);

  const notL5x = validateL5X('<Project><Controller/></Project>');
  assert.equal(notL5x.ok, false);
  assert.match(notL5x.errors[0], /missing <RSLogix5000Content>/);
});

test('validateL5X accepts a minimal well-formed L5X and reports undeclared tags', () => {
  const doc = (rung) => `<?xml version="1.0" encoding="UTF-8"?>
<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="37.00" TargetName="S01_Test" TargetType="Program">
<Controller Use="Context" Name="SDCController">
<Tags></Tags>
<Programs>
<Program Use="Target" Name="S01_Test">
<Tags>
<Tag Name="i_PartPresent" TagType="Base" DataType="BOOL"/>
<Tag Name="q_Clamp" TagType="Base" DataType="BOOL"/>
</Tags>
<Routines>
<Routine Name="R03_StateLogic" Type="RLL">
<RLLContent>
<Rung Number="0" Type="N"><Text><![CDATA[${rung}]]></Text></Rung>
</RLLContent>
</Routine>
</Routines>
</Program>
</Programs>
</Controller>
</RSLogix5000Content>`;

  const good = validateL5X(doc('XIC(i_PartPresent)OTE(q_Clamp);'));
  assert.equal(good.ok, true, good.errors.join('\n'));

  const bad = validateL5X(doc('XIC(i_Missing)OTE(q_Clamp);'));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('i_Missing')), bad.errors.join('\n'));

  assert.equal(typeof formatReport(good), 'string');
});
