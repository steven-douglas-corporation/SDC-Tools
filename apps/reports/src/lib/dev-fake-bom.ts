import "server-only";
import type { BomRow } from "@/lib/job-bom-rules";
import type { JobBomRecordsets } from "@/lib/job-bom";
import { fakePartsLines } from "@/lib/dev-fake-eto";

// ── Fake Total ETO BOM, for LOCAL DEVELOPMENT ONLY (docs/DEV-TEST-DATA.md §3) ──
//
// With SDC_DEV_FAKE_ETO=1, getJobBomResult takes its six result sets from here instead of
// Total ETO, and the real tree builder in job-bom-rules.ts does the rest. So Job Details >
// Procurement (Parts List, Card view, risk cards, PO panel) renders on a dev machine, and
// anything that changes how a BOM is built is exercised for real.
//
// Built from the same fake PO lines as the parts feed (dev-fake-eto.ts), so the BOM, the
// Parts List money and Open POs agree on PO numbers, suppliers, dates and receipts:
//   • every BOM-… part on a fake PO line is a requirement covered by that PO;
//   • MISC-… lines are POs with no BOM row (the PO panel's "not in the BOM" lines);
// plus the requirement states a PO line alone cannot show:
//   • three parts with no PO yet          • one part pulled from stock
//   • one part built in-house             • one part on hold
// Two sections (10 and 40), each a top assembly with two sub-assemblies. Deterministic:
// the same job id always yields the same BOM.

const DAY = 86_400_000;
const dateOf = (ymd: string | null | undefined) => (ymd ? new Date(`${ymd}T12:00:00`) : null);

export function fakeBomRecordsets(jobId: number): JobBomRecordsets {
  const lines = fakePartsLines(String(jobId)).filter((l) => l.poNumber && l.partNumber);
  const base = jobId * 10_000;

  // One item id per part number, the same id on its BOM row and its PO lines.
  const itemIds = new Map<string, number>();
  const itemId = (pn: string) => {
    let id = itemIds.get(pn);
    if (id == null) itemIds.set(pn, (id = base + 100 + itemIds.size));
    return id;
  };

  const poRows: JobBomRecordsets["poRows"] = lines.map((l, i) => {
    const received = Math.max(0, l.receivedQty ?? 0);
    const purchased = dateOf(l.purchaseDate);
    return {
      PurchaseOrderID: l.poNumber,
      PurchaseDate: purchased,
      PurchaseDateRequired: dateOf(l.requiredDate),
      Supplier: l.supplier,
      PurchaseDetailID: base + i,
      ItemID: itemId(l.partNumber!),
      PartNumber: l.partNumber,
      PartDesc: l.description,
      PurchaseQty: Math.abs(l.quantity),
      PurchasePrice: l.unitPrice,
      // Total ETO's line date is the re-promised one when a buyer entered it.
      DateRequired: dateOf(l.expectedDate ?? l.requiredDate),
      ReceivedQty: received,
      LastReceivedDate: received > 0 && purchased ? new Date(purchased.getTime() + 9 * DAY) : null,
    };
  });

  // Sections, top assemblies and sub-assemblies.
  const SECTIONS = [
    { spec: 10, title: "DEV Mechanical", subs: ["DEV Frame Weldment", "DEV Conveyor Module"] },
    { spec: 40, title: "DEV Electrical", subs: ["DEV Main Panel", "DEV Operator Station"] },
  ];
  const specs = SECTIONS.map((s) => ({ SpecID: s.spec, SDescription: s.title }));
  const tops = SECTIONS.map((s, i) => ({ SpecID: s.spec, TopItemID: base + 1 + i, TopPN: `TOP-${jobId}-${s.spec}`, TopDesc: `${s.title} top level` }));
  const subs = SECTIONS.flatMap((s, si) => s.subs.map((desc, k) => ({ spec: s.spec, top: tops[si], id: base + 10 + si * 2 + k, pn: `ASM-${jobId}-${s.spec}-${k + 1}`, desc })));

  const row = (o: Partial<BomRow> & Pick<BomRow, "ChildID" | "ChildPN" | "ParentID" | "ParentPN" | "SpecID">): BomRow => ({
    ChildDesc: null,
    Manufacturer: null,
    ParentDesc: null,
    ItemQty: 1,
    RequiredDate: null,
    ItemHold: 0,
    BOMAssemblyReleaseID: null,
    BOMCustom1: null,
    Note: null,
    ItemCost: null,
    ItemLastCost: null,
    ItemListCost: null,
    POQty: 0,
    ReceivedQty: 0,
    UnitPrice: 0,
    LastReceivedDate: null,
    ...o,
  });

  // Top → sub-assembly edges: Contents Only, so each sub-assembly explodes into its parts.
  const bomRows: BomRow[] = subs.map((s) =>
    row({ ChildID: s.id, ChildPN: s.pn, ChildDesc: s.desc, ParentID: s.top.TopItemID, ParentPN: s.top.TopPN, ParentDesc: s.top.TopDesc, SpecID: s.spec, BOMAssemblyReleaseID: 1 }),
  );

  // BOM parts on POs, spread across the four sub-assemblies. A part's PO figures are the
  // sums over its PO lines, as BOM_SQL's correlated subqueries compute them.
  const bomParts = [...new Set(lines.filter((l) => l.partNumber!.startsWith("BOM-")).map((l) => l.partNumber!))];
  bomParts.forEach((pn, i) => {
    const sub = subs[i % subs.length];
    const its = poRows.filter((p) => p.PartNumber === pn);
    const first = lines.find((l) => l.partNumber === pn)!;
    const received = its.reduce((s, p) => s + (p.ReceivedQty ?? 0), 0);
    const lastReceived = its.map((p) => p.LastReceivedDate).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    bomRows.push(
      row({
        ChildID: itemId(pn),
        ChildPN: pn,
        ChildDesc: first.description,
        Manufacturer: first.manufacturer,
        ParentID: sub.id,
        ParentPN: sub.pn,
        ParentDesc: sub.desc,
        SpecID: sub.spec,
        ItemQty: its.reduce((s, p) => s + (p.PurchaseQty ?? 0), 0) || 1,
        RequiredDate: dateOf(first.requiredDate),
        POQty: its.reduce((s, p) => s + (p.PurchaseQty ?? 0), 0),
        ReceivedQty: received,
        UnitPrice: first.unitPrice,
        LastReceivedDate: lastReceived,
        ItemCost: first.unitPrice,
      }),
    );
  });

  // Requirements a PO line cannot show. Ids above the PO parts' range.
  const extras = [
    { pn: `BOM-${jobId}-NOPO-1`, desc: "DEV part not yet ordered", qty: 4, cost: 42.5 },
    { pn: `BOM-${jobId}-NOPO-2`, desc: "DEV part not yet ordered", qty: 2, cost: 310 },
    { pn: `BOM-${jobId}-NOPO-3`, desc: "DEV part not yet ordered", qty: 12, cost: 7.25 },
    { pn: `BOM-${jobId}-STOCK`, desc: "DEV part pulled from stock", qty: 6, cost: 18 },
    { pn: `BOM-${jobId}-MAKE`, desc: "DEV part built in-house", qty: 1, cost: 0 },
    { pn: `BOM-${jobId}-HOLD`, desc: "DEV part on engineering hold", qty: 3, cost: 95 },
  ];
  const soon = new Date(Date.now() + 21 * DAY);
  extras.forEach((e, i) => {
    const sub = subs[i % subs.length];
    bomRows.push(
      row({
        ChildID: itemId(e.pn),
        ChildPN: e.pn,
        ChildDesc: e.desc,
        ParentID: sub.id,
        ParentPN: sub.pn,
        ParentDesc: sub.desc,
        SpecID: sub.spec,
        ItemQty: e.qty,
        RequiredDate: soon,
        ItemHold: e.pn.endsWith("HOLD") ? 1 : 0,
        ItemCost: e.cost,
        ItemLastCost: e.cost,
      }),
    );
  });

  const pullRows: JobBomRecordsets["pullRows"] = [
    { ItemID: itemId(`BOM-${jobId}-STOCK`), PullQty: 6, FulfilledQty: 6, PullPrice: 18, FulfilledDate: new Date(Date.now() - 10 * DAY) },
  ];
  const processRows: JobBomRecordsets["processRows"] = [{ ItemID: itemId(`BOM-${jobId}-MAKE`) }];

  return { specs, tops, bomRows, poRows, pullRows, processRows };
}
