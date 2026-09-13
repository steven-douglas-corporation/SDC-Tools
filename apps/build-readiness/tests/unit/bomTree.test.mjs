// Unit tests for the pure BOM/PO helpers in server/lib/bomTree.js.
// No database, network or filesystem access — every input is an in-memory fixture.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree,
  getAssemblyStats,
  buildNestedTree,
  buildReadinessSummary,
  buildPoIndex,
  buildPoActionList,
  findNoPoParts,
} from '../../server/lib/bomTree.js';

// One BOM row as Total ETO's tblEngProductStructure query returns it.
function row(ParentID, ChildID, { qty = 1, po = 0, rcv = 0, hold = false, pn } = {}) {
  return {
    ParentID,
    ParentPN: `PN-${ParentID}`,
    ParentDesc: `Desc ${ParentID}`,
    ChildID,
    ChildPN: pn || `PN-${ChildID}`,
    ChildDesc: `Desc ${ChildID}`,
    Manufacturer: 'ACME',
    ItemQty: qty,
    POQty: po,
    ReceivedQty: rcv,
    RequiredDate: '2026-10-01',
    ItemHold: hold,
    UnitPrice: 10,
    LastReceivedDate: rcv >= qty && rcv > 0 ? '2026-09-01' : null,
  };
}

// TOP(1) -> machine A(10) -> S1(100) ready, S2(101) 60% "close", S3(102) blocked
//        -> machine A also has direct part 1003 (no PO)
//        -> loose part 2001 directly under TOP
const ROWS = [
  row(1, 10),
  row(10, 100),
  row(10, 101),
  row(10, 102),
  row(100, 1001, { qty: 2, po: 2, rcv: 2 }),
  row(100, 1001, { qty: 2, po: 2, rcv: 2 }), // exact duplicate (ChildID, ParentID) — must be dropped
  row(100, 1002, { po: 1, rcv: 1 }),
  row(101, 1004, { po: 1, rcv: 1 }),
  row(101, 1005, { po: 1, rcv: 1 }),
  row(101, 1006, { po: 1, rcv: 1 }),
  row(101, 1007, { po: 1, rcv: 0 }), // ordered
  row(101, 1008), // no PO
  row(102, 1009), // no PO
  row(102, 1010, { hold: true }), // no PO but on hold in Total ETO
  row(102, 1003), // same part also used directly under the machine
  row(10, 1003),
  row(1, 2001, { po: 1, rcv: 1 }),
];

describe('buildTree', () => {
  const { assemblyIds, childrenMap, topParentIds, deduped } = buildTree(ROWS);

  test('drops exact (ChildID, ParentID) duplicates', () => {
    assert.equal(deduped.length, ROWS.length - 1);
  });

  test('every ParentID is an assembly; leaf parts are not', () => {
    assert.deepEqual([...assemblyIds].sort((a, b) => a - b), [1, 10, 100, 101, 102]);
    assert.equal(assemblyIds.has(1003), false);
  });

  test('finds the single top-level parent and groups children by parent', () => {
    assert.deepEqual(topParentIds, [1]);
    assert.deepEqual(childrenMap[10].map(r => r.ChildID), [100, 101, 102, 1003]);
    assert.equal(childrenMap[9999], undefined);
  });
});

describe('getAssemblyStats', () => {
  const { assemblyIds, childrenMap } = buildTree(ROWS);

  test('classifies received / ordered / noPO and rounds the percentage', () => {
    assert.deepEqual(getAssemblyStats(100, childrenMap, assemblyIds), { total: 2, received: 2, noPO: 0, ordered: 0, pct: 100 });
    assert.deepEqual(getAssemblyStats(101, childrenMap, assemblyIds), { total: 5, received: 3, noPO: 1, ordered: 1, pct: 60 });
    assert.deepEqual(getAssemblyStats(102, childrenMap, assemblyIds), { total: 3, received: 0, noPO: 3, ordered: 0, pct: 0 });
  });

  test('counts a part used in several places once, and rolls leaves up through sub-assemblies', () => {
    // Machine A: 1001,1002,1004..1008,1009,1010,1003 = 10 unique leaves, 5 received.
    assert.deepEqual(getAssemblyStats(10, childrenMap, assemblyIds), { total: 10, received: 5, noPO: 4, ordered: 1, pct: 50 });
    // TOP adds the loose part 2001 (received): 6 / 11 = 54.5 -> 55.
    assert.equal(getAssemblyStats(1, childrenMap, assemblyIds).pct, 55);
  });

  test('an assembly with no leaves is 0%, not NaN', () => {
    assert.deepEqual(getAssemblyStats(424242, childrenMap, assemblyIds), { total: 0, received: 0, noPO: 0, ordered: 0, pct: 0 });
  });
});

describe('buildNestedTree', () => {
  const { assemblyIds, childrenMap } = buildTree(ROWS);
  const poIndex = { 1007: [{ poId: 77, supplier: 'Beta' }] };
  const tree = buildNestedTree(1, 'TOP-PN', 'Top level', childrenMap, assemblyIds, poIndex);

  test('mirrors the hierarchy: assemblies under children[], leaves under parts[]', () => {
    assert.equal(tree.isAssembly, true);
    assert.deepEqual(tree.children.map(c => c.id), [10]);
    assert.deepEqual(tree.parts.map(p => p.id), [2001]);
    const machine = tree.children[0];
    assert.deepEqual(machine.children.map(c => c.id), [100, 101, 102]);
    assert.deepEqual(machine.parts.map(p => p.id), [1003]);
  });

  test('gives every leaf a status and attaches its PO lines', () => {
    const s2 = tree.children[0].children[1];
    const byId = Object.fromEntries(s2.parts.map(p => [p.id, p]));
    assert.equal(byId[1004].status, 'received');
    assert.equal(byId[1007].status, 'ordered');
    assert.equal(byId[1008].status, 'noPO');
    assert.deepEqual(byId[1007].pos, poIndex[1007]);
    assert.deepEqual(byId[1008].pos, []);
  });

  test('falls back to placeholders for a missing part number / description', () => {
    const bare = buildNestedTree(555, null, undefined, {}, new Set());
    assert.equal(bare.pn, '???');
    assert.equal(bare.desc, '');
    assert.equal(bare.isAssembly, false);
  });
});

describe('buildReadinessSummary', () => {
  const { assemblyIds, childrenMap } = buildTree(ROWS);
  const { machines } = buildReadinessSummary(1, 'TOP-PN', 'Top level', childrenMap, assemblyIds, {});

  test('buckets sub-assemblies at 100% ready, >= 60% close, otherwise blocked', () => {
    const machine = machines[0];
    assert.equal(machine.id, 10);
    assert.deepEqual(machine.subAssemblies.ready.map(s => s.id), [100]);
    assert.deepEqual(machine.subAssemblies.close.map(s => s.id), [101]);
    assert.deepEqual(machine.subAssemblies.blocked.map(s => s.id), [102]);
    assert.deepEqual(machine.parts.map(p => p.id), [1003]);
  });

  test('collects parts directly under TOP into a synthetic "loose-parts" machine', () => {
    assert.equal(machines.length, 2);
    const loose = machines[1];
    assert.equal(loose.id, 'loose-parts');
    assert.deepEqual(loose.stats, { total: 1, received: 1, noPO: 0, ordered: 0, pct: 100 });
    assert.deepEqual(loose.node.parts.map(p => p.id), [2001]);
  });
});

describe('buildPoIndex', () => {
  test('groups PO lines by ItemID and prefers the line-level DateRequired', () => {
    const idx = buildPoIndex([
      { ItemID: 7, PurchaseOrderID: 100, Supplier: 'Acme', DateRequired: '2026-09-20', PurchaseDateRequired: '2026-09-30', PurchaseQty: 2, ReceivedQty: 1 },
      { ItemID: 7, PurchaseOrderID: 101, Supplier: 'Beta', DateRequired: null, PurchaseDateRequired: '2026-10-05', PurchaseQty: 1, ReceivedQty: 0 },
      { ItemID: 8, PurchaseOrderID: 100, Supplier: 'Acme', DateRequired: '2026-09-20', PurchaseQty: 5, ReceivedQty: 5, LastReceivedDate: '2026-09-10' },
    ]);
    assert.deepEqual(Object.keys(idx).sort(), ['7', '8']);
    assert.deepEqual(idx[7].map(l => l.poId), [100, 101]);
    assert.equal(idx[7][0].dueDate, '2026-09-20');
    assert.equal(idx[7][1].dueDate, '2026-10-05');
    assert.equal(idx[7][1].receivedDate, null);
    assert.equal(idx[8][0].receivedDate, '2026-09-10');
  });

  test('tolerates a missing row set', () => {
    assert.deepEqual(buildPoIndex(undefined), {});
  });
});

describe('buildPoActionList', () => {
  const DAY = 86400000;
  const daysFromNow = n => new Date(Date.now() + n * DAY).toISOString();
  const line = (Supplier, PurchaseOrderID, qty, rcv, DateRequired, PurchaseDateRequired = null) => ({
    Supplier,
    SupplierEmail: `${Supplier.toLowerCase()}@example.com`,
    PurchaseOrderID,
    PurchaseDate: daysFromNow(-40),
    PurchaseDateRequired,
    DateRequired,
    PartNumber: `P-${PurchaseOrderID}-${qty}`,
    PartDesc: 'part',
    PurchaseQty: qty,
    ReceivedQty: rcv,
    PurchasePrice: 1,
  });
  const result = buildPoActionList([
    line('Acme', 500, 5, 5, daysFromNow(-20)), // fully received -> delivered, even though "overdue"
    line('Acme', 501, 2, 0, daysFromNow(-5)), // 5 days late -> critical
    line('Beta', 600, 1, 0, daysFromNow(7)), // due in a week -> warning
    line('Beta', 601, 3, 1, null, daysFromNow(30)), // header date only -> on track
    line('Beta', 601, 1, 1, daysFromNow(-10)), // received line on the same PO must not drag it into critical
  ]);

  test('sorts each PO into exactly one urgency bucket', () => {
    assert.deepEqual(result.delivered.map(e => e.po.poId), [500]);
    assert.deepEqual(result.critical.map(e => e.po.poId), [501]);
    assert.deepEqual(result.warning.map(e => e.po.poId), [600]);
    assert.deepEqual(result.onTrack.map(e => e.po.poId), [601]);
  });

  test('computes worst-case days from open lines only and flattens the supplier onto the entry', () => {
    assert.equal(result.critical[0].worstDays, -5);
    assert.equal(result.warning[0].worstDays, 7);
    assert.equal(result.onTrack[0].worstDays, 30);
    assert.equal(result.critical[0].supplier, 'Acme');
    assert.equal(result.critical[0].email, 'acme@example.com');
    assert.equal('pos' in result.critical[0], false);
    assert.deepEqual(result.onTrack[0].po.parts.map(p => p.remaining), [2, 0]);
  });
});

describe('findNoPoParts', () => {
  const { assemblyIds } = buildTree(ROWS);
  const noPo = findNoPoParts(ROWS, assemblyIds);

  test('returns leaf parts with no PO, skips on-hold items, and reports a shared part once', () => {
    assert.deepEqual(noPo.map(p => p.id).sort((a, b) => a - b), [1003, 1008, 1009]);
  });

  test('carries the parent context the UI groups by', () => {
    const p1008 = noPo.find(p => p.id === 1008);
    assert.equal(p1008.parentPN, 'PN-101');
    assert.equal(p1008.pn, 'PN-1008');
    assert.equal(p1008.qty, 1);
    assert.equal(p1008.unitPrice, 10);
  });
});
