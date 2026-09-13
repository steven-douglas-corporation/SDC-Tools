// DFS state numbering (src/lib/computeStateNumbers.js) — no imports, fully pure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStateNumbers } from '../../src/lib/computeStateNumbers.js';

const node = (id, x, y, data = {}) => ({ id, position: { x, y }, data });
const edge = (source, target) => ({ id: `${source}-${target}`, source, target });

test('empty diagram yields empty maps', () => {
  const r = computeStateNumbers([], []);
  assert.equal(r.stateMap.size, 0);
  assert.equal(r.visionSubStepsMap.size, 0);
});

test('linear chain numbers 1, 4, 7 from the initial node', () => {
  const nodes = [node('home', 0, 0, { isInitial: true }), node('a', 0, 100), node('b', 0, 200)];
  const { stateMap } = computeStateNumbers(nodes, [edge('home', 'a'), edge('a', 'b')], []);
  assert.equal(stateMap.get('home'), 1);
  assert.equal(stateMap.get('a'), 4);
  assert.equal(stateMap.get('b'), 7);
});

test('branches are visited left-to-right by target X position', () => {
  const nodes = [node('home', 0, 0, { isInitial: true }), node('right', 300, 100), node('left', -300, 100)];
  const { stateMap } = computeStateNumbers(nodes, [edge('home', 'right'), edge('home', 'left')], []);
  assert.equal(stateMap.get('left'), 4);
  assert.equal(stateMap.get('right'), 7);
});

test('fault nodes are always 127 and do not consume a sequence slot', () => {
  const nodes = [node('home', 0, 0, { isInitial: true }), node('flt', 0, 50, { isFault: true }), node('a', 0, 100)];
  const { stateMap } = computeStateNumbers(nodes, [edge('home', 'flt'), edge('home', 'a')], []);
  assert.equal(stateMap.get('flt'), 127);
  assert.equal(stateMap.get('a'), 4);
});

test('recovery: completeStep pins Cycle Complete and is skipped by the counter', () => {
  const nodes = [
    node('home', 0, 0, { isInitial: true }),
    node('a', 0, 100),
    node('done', 0, 200, { label: 'Cycle Complete' }),
  ];
  const edges = [edge('home', 'a'), edge('a', 'done')];
  const { stateMap } = computeStateNumbers(nodes, edges, [], { startAt: 100, completeStep: 124 });
  assert.equal(stateMap.get('home'), 100);
  assert.equal(stateMap.get('a'), 103);
  assert.equal(stateMap.get('done'), 124);

  // A long enough recovery chain must step over 124 rather than collide with it.
  const many = [node('home', 0, 0, { isInitial: true })];
  const manyEdges = [];
  let prev = 'home';
  for (let i = 0; i < 9; i++) {
    many.push(node(`n${i}`, 0, (i + 1) * 10));
    manyEdges.push(edge(prev, `n${i}`));
    prev = `n${i}`;
  }
  const r = computeStateNumbers(many, manyEdges, [], { startAt: 100, completeStep: 124 });
  const assigned = [...r.stateMap.values()];
  assert.ok(!assigned.includes(124), `124 must be reserved, got ${assigned.join(',')}`);
});

test('a VisionSystem Inspect action reserves five sub-steps', () => {
  const devices = [{ id: 'cam', type: 'VisionSystem' }];
  const nodes = [
    node('home', 0, 0, { isInitial: true }),
    node('insp', 0, 100, { actions: [{ deviceId: 'cam', operation: 'Inspect' }] }),
    node('next', 0, 200),
  ];
  const r = computeStateNumbers(nodes, [edge('home', 'insp'), edge('insp', 'next')], devices);
  assert.deepEqual(r.visionSubStepsMap.get('insp'), [4, 7, 10, 13, 16]);
  assert.equal(r.stateMap.get('next'), 19);
});

test('without an initial node, nodes are numbered top-to-bottom by Y', () => {
  const nodes = [node('low', 0, 300), node('high', 0, 0), node('mid', 0, 150)];
  const { stateMap } = computeStateNumbers(nodes, [], []);
  assert.equal(stateMap.get('high'), 1);
  assert.equal(stateMap.get('mid'), 4);
  assert.equal(stateMap.get('low'), 7);
});
