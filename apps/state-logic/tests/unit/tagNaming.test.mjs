// Pure SDC tag-naming helpers (src/lib/tagNaming.js). No React/Zustand at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProgramName,
  getDeviceTags,
  getSensorTagForOperation,
  getOutputTagForOperation,
  getDelayTimerForOperation,
  getParameterTag,
  buildTransitionLabel,
} from '../../src/lib/tagNaming.js';

const cyl = {
  id: 'd1',
  type: 'PneumaticLinearActuator',
  name: 'StampCyl',
  displayName: 'Stamp Cylinder',
  sensorArrangement: '2-sensor (Ext + Ret)',
};

test('buildProgramName pads the station and strips non-alphanumerics', () => {
  assert.equal(buildProgramName(2, 'Stamp Cycle'), 'S02_StampCycle');
  assert.equal(buildProgramName(12, 'PNP-Load!'), 'S12_PNPLoad');
  assert.equal(buildProgramName('7', 'A'), 'S07_A');
});

test('getDeviceTags emits SDC full-word tags for a 2-sensor cylinder', () => {
  const tags = getDeviceTags(cyl);
  const names = tags.map((t) => t.name);
  for (const expected of [
    'i_StampCylExtended',
    'i_StampCylRetracted',
    'q_ExtendStampCyl',
    'q_RetractStampCyl',
    'StampCylExtendDelay',
    'StampCylRetractDelay',
    'StampCylExtendDebounce',
  ]) {
    assert.ok(names.includes(expected), `missing ${expected} in ${names.join(', ')}`);
  }
  const timer = tags.find((t) => t.name === 'StampCylExtendDelay');
  assert.equal(timer.dataType, 'TIMER');
  assert.equal(timer.usage, 'Local');
  assert.equal(timer.preMs, 500); // DEVICE_TYPES default
});

test('getDeviceTags drops the extend sensor for a 1-sensor arrangement', () => {
  const names = getDeviceTags({ ...cyl, sensorArrangement: '1-sensor (Ret only)' }).map((t) => t.name);
  assert.ok(!names.includes('i_StampCylExtended'));
  assert.ok(names.includes('i_StampCylRetracted'));
});

test('getDeviceTags returns [] for an unknown device type', () => {
  assert.deepEqual(getDeviceTags({ type: 'Nope', name: 'X' }), []);
});

test('per-operation tag lookups follow the device-type patterns', () => {
  assert.equal(getSensorTagForOperation(cyl, 'Extend'), 'i_StampCylExtended');
  assert.equal(getSensorTagForOperation(cyl, 'Retract'), 'i_StampCylRetracted');
  assert.equal(getOutputTagForOperation(cyl, 'Extend'), 'q_ExtendStampCyl');
  assert.equal(getOutputTagForOperation(cyl, 'Retract'), 'q_RetractStampCyl');
  assert.equal(getDelayTimerForOperation(cyl, 'Extend'), 'StampCylExtendDelay');
  assert.equal(getSensorTagForOperation(cyl, 'NotAnOperation'), null);
});

test('getParameterTag scopes cross-SM parameters to the owning program', () => {
  const local = { type: 'Parameter', name: 'Speed', dataType: 'real' };
  assert.equal(getParameterTag(local), 'p_Speed');
  assert.equal(getParameterTag({ ...local, dataType: 'boolean' }), 'q_Speed');
  const cross = { ...local, paramScope: 'cross-sm', crossSmId: 'sm2' };
  const sms = [{ id: 'sm2', stationNumber: 3, name: 'Press Station' }];
  assert.equal(getParameterTag(cross, sms), '\\S03_PressStation.p_Speed');
  assert.equal(getParameterTag({ type: 'ServoAxis', name: 'X' }), null);
});

test('buildTransitionLabel renders each condition type', () => {
  const devices = [{ id: 'd1', displayName: 'Stamp Cylinder' }];
  assert.equal(buildTransitionLabel(null), '?');
  assert.equal(buildTransitionLabel({ conditionType: 'timer', delayMs: 250 }), 'Timer 250ms');
  assert.equal(buildTransitionLabel({ conditionType: 'sensorOn', deviceId: 'd1' }, devices), "'Stamp Cylinder' ON");
  assert.equal(buildTransitionLabel({ conditionType: 'always' }), '(immediate)');
  assert.equal(buildTransitionLabel({ conditionType: 'custom', customLabel: 'Hand-written' }), 'Hand-written');
});
