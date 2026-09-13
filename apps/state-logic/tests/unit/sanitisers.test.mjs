// Name/ID sanitising and text heuristics that live in side-effect-free modules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toFilename } from '../../src/lib/projectApi.js';
import { assessCoverage, scoreCoverage } from '../../src/lib/coverageChecklist.js';

test('toFilename produces a safe .json filename', () => {
  assert.equal(toFilename('1147 Stuller Protektor'), '1147_Stuller_Protektor.json');
  // Whitespace is collapsed to '_' before the trim, so outer spaces survive as underscores.
  assert.equal(toFilename('  weird / name : v2  '), '_weird_name_v2_.json');
  assert.equal(toFilename('weird / name : v2'), 'weird_name_v2.json');
  assert.equal(toFilename('a___b'), 'a_b.json');
  assert.equal(toFilename(''), 'project.json');
  assert.equal(toFilename(undefined), 'project.json');
  assert.equal(toFilename('!!!'), 'project.json');
  assert.equal(toFilename('keep-dash_and_underscore'), 'keep-dash_and_underscore.json');
});

test('assessCoverage scores an empty description as zero with a hint per item', () => {
  const r = assessCoverage('');
  assert.deepEqual(r.scores, { devices: 0, sequence: 0, failures: 0, interactions: 0 });
  assert.deepEqual(Object.keys(r.messages).sort(), ['devices', 'failures', 'interactions', 'sequence']);
});

test('assessCoverage rewards a full description and scoreCoverage is the scores subset', () => {
  const text =
    'The clamp cylinder extends first, then the stamp cylinder extends once the sensor sees the part; ' +
    'after that the gripper retracts. If a part is missing or jams, retry once then fault and alert the operator. ' +
    'This station waits for the Load Station and hands off to the Unload Station.';
  const opts = { otherSmNames: ['Load Station', 'Unload Station'] };
  const r = assessCoverage(text, opts);
  for (const k of ['devices', 'sequence', 'failures', 'interactions']) {
    assert.ok(r.scores[k] >= 1, `${k} should score, got ${r.scores[k]}`);
  }
  assert.equal(r.scores.devices, 2);
  assert.equal(r.scores.failures, 2);
  assert.deepEqual(scoreCoverage(text, opts), assessCoverage(text, opts).scores);
});
