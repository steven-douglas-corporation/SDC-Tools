import "server-only";
import sql from "mssql";
import { totalEtoConfig, TOTALETO_TIMEOUT, withTotalEto, describeTotalEtoFailure } from "@/lib/totaleto-connection";
import {
  type BomContext,
  type BomNode,
  type BomRow,
  type PoLine,
  type PullInfo,
  buildAssembly,
  buildSpecTree,
  clean,
  iso,
  rollUp,
  statsForRoots,
} from "./job-bom-rules";

// Native procurement BOM — ported from the Build Readiness report
// (Centrailized library/Build_Readiness_Report). Instead of the cost-only
// `vwEngBOM` explosion this used to run, it pulls the same engineering product
// structure the Build Readiness page uses (tblEngProductStructure +
// tblEngItemMaster) plus purchase-order / receiver data, so every requirement
// carries its PO status, supplier, and dates and every assembly carries a
// readiness rollup.
//
// Hierarchy: one synthetic section node per SpecID (the report's "sections"
// 10/30/40/90) → the spec's top node(s) from tblEngTop are exploded into nested
// assemblies → parts.
//
// This module is the I/O half. Every rule about WHAT counts as a requirement,
// what covers it and what it costs lives in `job-bom-rules.ts` — read that file's
// header first; it explains BOM release status (Assembly Only / Both / Contents
// Only), why "no PO" is not the same as "missing", and the cost fallback chain.
// Kept defensive/fail-soft throughout: an unknown job or a query error yields an
// empty JobBom.

export type { BomStats, BomPart, BomNode, ReleaseStatus, PartSource, CostBasis } from "./job-bom-rules";

// Authoritative per-line PO data (from tblPurchaseOrderDetails + tblReceiverLog)
// — the supplier's own line counts, independent of the BOM explosion. Used to
// override the BOM-derived received/total in the Card view + PO panel.
export type PoLineDetail = {
  /**
   * `pod:<PurchaseDetailID>` — the same stable id PartsCostLine.lineId carries,
   * so the Parts List can attach a purchase line's expected/received dates to
   * its money without joining on a part number the two queries spell
   * differently (34 of job 1116's 1083 lines disagree). Same string on both
   * sides by construction: both are built from POD.PurchaseDetailID.
   */
  lineId: string;
  partNumber: string;
  desc: string;
  qty: number;
  price: number;
  orderedDate: string | null; // poh.PurchaseDate
  expectedDate: string | null; // DateRequired || PurchaseDateRequired
  receivedQty: number;
  receivedDate: string | null;
  status: "received" | "ordered"; // received when receivedQty >= qty
};

export type PoLineGroup = {
  poId: string;
  itemCount: number; // # lines on this PO
  received: number; // # lines fully received
  pct: number;
  lines: PoLineDetail[];
};

export type Vendor = {
  name: string;
  pos: PoLineGroup[];
};

export type JobBom = {
  jobId: string;
  roots: BomNode[]; // one section node per SpecID
  grandTotalCost: number;
  grandTotalPartQty: number;
  rowCount: number;
  vendors: Vendor[]; // authoritative supplier → PO line rollups (fail-soft: [])
};

// Total ETO connection — same server/db/creds as sync-totaleto.ts. DO NOT CHANGE.
// The connection config moved to lib/totaleto-connection.ts (2026-09-01):
// this file held one of FOUR byte-identical copies, which is what made a single
// shared credential failure look like four unrelated ones. `config` below is that
// shared definition, with this file's own requestTimeout.
const config = totalEtoConfig(TOTALETO_TIMEOUT.bom);

// ---------- SQL (ported from server/services/eto.js) ----------

const SPECS_SQL = `
  SELECT SpecID, SDescription
  FROM tblSpec
  WHERE ProjectID = @job
  ORDER BY SpecID`;

const TOP_SQL = `
  SELECT et.SpecID, et.ItemID AS TopItemID,
         eim.ItemCompanyID AS TopPN, eim.ItemDescription AS TopDesc
  FROM tblEngTop et
  JOIN tblEngItemMaster eim ON et.ItemID = eim.ItemID
  WHERE et.ProjectID = @job`;

// One project-wide pull (SpecID carried per row) instead of the reference's
// per-spec round-trip — the PO/received subqueries are keyed by ItemID +
// ProjectID (not SpecID), so the per-row values are byte-identical.
//
// `BOMAssemblyReleaseID` is the release status of this parent→child edge
// (tsysBOMAssemblyRelease: 1 Contents Only / 2 Assembly Only / 3 Both) and is
// what decides whether the child is exploded or bought whole.
//
// `BOMCustom1` and `Note` both carry the Packet ID — the tag that groups the
// release rows belonging to one fragmented assembly update, so Build Readiness
// can answer "are the parts for THIS change ready" (see packetIdOf() in
// job-bom-rules.ts for which of the two wins). Both live on eps, i.e. per
// parent→child EDGE, which is exactly the grain Purchasing asked for: a part
// reused by two packets has two rows and stays correctly separated. `ItemCost`,
// `ItemLastCost` and `ItemListCost` feed the cost fallback for requirements
// that have no PO price of their own — both are applied in job-bom-rules.ts.
const BOM_SQL = `
  SELECT
    eps.ChildID,
    child.ItemCompanyID   AS ChildPN,
    child.ItemDescription AS ChildDesc,
    child.Manufacturer    AS Manufacturer,
    eps.ParentID,
    parent.ItemCompanyID   AS ParentPN,
    parent.ItemDescription AS ParentDesc,
    eps.ItemQty,
    eps.SpecID,
    eps.RequiredDate,
    eps.ItemHold,
    eps.BOMAssemblyReleaseID,
    eps.BOMCustom1,
    eps.Note,
    eps.ItemCost,
    child.ItemLastCost,
    child.ItemListCost,
    ISNULL((
      SELECT SUM(pod.PurchaseQty)
      FROM tblPurchaseOrderDetails pod
      WHERE pod.ProjectID = @job AND pod.ItemID = eps.ChildID
    ), 0) AS POQty,
    ISNULL((
      SELECT SUM(rl.QtyReceived)
      FROM tblReceiverLog rl
      JOIN tblPurchaseOrderDetails pod2 ON rl.PurchaseDetailID = pod2.PurchaseDetailID
      WHERE pod2.ProjectID = @job AND pod2.ItemID = eps.ChildID
    ), 0) AS ReceivedQty,
    ISNULL((
      SELECT TOP 1 pod3.PurchasePrice
      FROM tblPurchaseOrderDetails pod3
      WHERE pod3.ProjectID = @job AND pod3.ItemID = eps.ChildID AND pod3.PurchasePrice > 0
      ORDER BY pod3.PurchaseDetailID DESC
    ), 0) AS UnitPrice,
    (
      SELECT TOP 1 rl3.[Date]
      FROM tblReceiverLog rl3
      JOIN tblPurchaseOrderDetails pod5 ON rl3.PurchaseDetailID = pod5.PurchaseDetailID
      WHERE pod5.ProjectID = @job AND pod5.ItemID = eps.ChildID
      ORDER BY rl3.[Date] DESC
    ) AS LastReceivedDate
  FROM tblEngProductStructure eps
  JOIN tblEngItemMaster child  ON eps.ChildID  = child.ItemID
  JOIN tblEngItemMaster parent ON eps.ParentID = parent.ItemID
  WHERE eps.ProjectID = @job
  ORDER BY eps.SpecID, parent.ItemCompanyID, child.ItemCompanyID`;

// Inventory issued to this job — the reason a legitimately-covered part can have
// no purchase order at all. Grouped per item rather than added as two more
// correlated subqueries on BOM_SQL, which already carries four.
//
// Only positive PullQty counts: a negative row is stock going BACK on the shelf
// (a return/credit), and summing it in would net a real issue away to zero.
// FulfilledStatus <> 0 is the part physically leaving the shelf for the job.
const PULLS_SQL = `
  SELECT
    ipd.ItemID,
    SUM(ipd.PullQty) AS PullQty,
    SUM(CASE WHEN ipd.FulfilledStatus <> 0 THEN ipd.PullQty ELSE 0 END) AS FulfilledQty,
    MAX(ipd.PullPrice) AS PullPrice,
    MAX(ipd.FulfilledDate) AS FulfilledDate
  FROM tblInventoryPullDetails ipd
  WHERE ipd.ProjectID = @job AND ipd.PullQty > 0
  GROUP BY ipd.ItemID`;

// Items built in-house on an ETO process schedule — the other legitimate reason
// a requirement never gets a purchase order.
const PROCESS_SQL = `
  SELECT DISTINCT psh.ItemID
  FROM tblProcessScheduleHeader psh
  WHERE psh.ProjectID = @job AND psh.Active = 1 AND psh.ItemID IS NOT NULL`;

// Full per-line PO query (mirrors Build Readiness getPoDetails) — every real PO
// line with its own received qty/date, so vendor cards can show authoritative
// line counts and the PO panel can list lines that aren't in the BOM. The
// per-part supplier/expected join (buildPoIndex) still reads from these rows.
const PO_SQL = `
  SELECT
    poh.PurchaseOrderID,
    poh.PurchaseDate,
    poh.PurchaseDateRequired,
    c.CName AS Supplier,
    pod.PurchaseDetailID,
    pod.ItemID,
    eim.ItemCompanyID AS PartNumber,
    eim.ItemDescription AS PartDesc,
    pod.PurchaseQty,
    pod.PurchasePrice,
    pod.DateRequired,
    ISNULL((
      SELECT SUM(rl.QtyReceived)
      FROM tblReceiverLog rl
      WHERE rl.PurchaseDetailID = pod.PurchaseDetailID
    ), 0) AS ReceivedQty,
    (
      SELECT TOP 1 rl2.[Date]
      FROM tblReceiverLog rl2
      WHERE rl2.PurchaseDetailID = pod.PurchaseDetailID
      ORDER BY rl2.[Date] DESC
    ) AS LastReceivedDate
  FROM tblPurchaseOrderDetails pod
  JOIN tblPurchaseOrderHeader poh ON pod.PurchaseOrderID = poh.PurchaseOrderID
  JOIN tblCompany c               ON poh.PurchaseSupplierID = c.CompanyID
  JOIN tblEngItemMaster eim       ON pod.ItemID = eim.ItemID
  WHERE pod.ProjectID = @job
    AND eim.ItemCompanyID NOT IN ('Shipping', 'FEE', 'TARIFF')
  ORDER BY c.CName, pod.DateRequired`;

// ---------- Row shapes ----------

type TopRow = { SpecID: number; TopItemID: number; TopPN: string | null; TopDesc: string | null };
type SpecRow = { SpecID: number; SDescription: string | null };
type PullRow = {
  ItemID: number;
  PullQty: number | null;
  FulfilledQty: number | null;
  PullPrice: number | null;
  FulfilledDate: Date | null;
};
type ProcessRow = { ItemID: number };
type PoRow = {
  PurchaseOrderID: string | number | null;
  PurchaseDate: Date | null;
  PurchaseDateRequired: Date | null;
  Supplier: string | null;
  PurchaseDetailID: number | null;
  ItemID: number;
  PartNumber: string | null;
  PartDesc: string | null;
  PurchaseQty: number | null;
  PurchasePrice: number | null;
  DateRequired: Date | null;
  ReceivedQty: number | null;
  LastReceivedDate: Date | null;
};

// ---------- Index builders ----------

// PO index: ItemID → PO lines. Supplier/expected-date for a part come from its
// first PO line (dueDate = DateRequired || PurchaseDateRequired), matching
// buildPoIndex in the reference.
function buildPoIndex(rows: PoRow[]): Map<number, PoLine[]> {
  const idx = new Map<number, PoLine[]>();
  for (const r of rows) {
    const originalDate = iso(r.PurchaseDateRequired);
    const lineDate = iso(r.DateRequired);
    const line: PoLine = {
      poId: r.PurchaseOrderID != null ? String(r.PurchaseOrderID) : null,
      supplier: r.Supplier ?? null,
      dueDate: lineDate ?? originalDate,
      orderedDate: iso(r.PurchaseDate),
      originalDate,
      // Only a revision if it actually moved. Repeating the same date in both
      // columns would make every line look rescheduled.
      revisedDate: lineDate && lineDate !== originalDate ? lineDate : null,
    };
    const arr = idx.get(r.ItemID);
    if (arr) arr.push(line);
    else idx.set(r.ItemID, [line]);
  }
  return idx;
}

function buildPullIndex(rows: PullRow[]): Map<number, PullInfo> {
  const idx = new Map<number, PullInfo>();
  for (const r of rows) {
    idx.set(r.ItemID, {
      pullQty: Number(r.PullQty) || 0,
      fulfilledQty: Number(r.FulfilledQty) || 0,
      pullPrice: Number(r.PullPrice) || 0,
      fulfilledDate: r.FulfilledDate ?? null,
    });
  }
  return idx;
}

// Authoritative vendor → PO line rollups from the raw PO rows (mirrors the
// reference buildPoIndex/getPoDetails shape used by the Scheduler's card merge).
// Fully fail-soft: any error yields [] so the BOM-derived counts stay in charge.
function buildVendors(rows: PoRow[]): Vendor[] {
  try {
    const byVendor = new Map<string, Map<string, PoLineDetail[]>>();
    for (const r of rows) {
      const poId = r.PurchaseOrderID != null ? String(r.PurchaseOrderID) : "";
      if (!poId) continue;
      const name = clean(r.Supplier) || "No Supplier";
      const qty = Number(r.PurchaseQty) || 0;
      const receivedQty = Number(r.ReceivedQty) || 0;
      const line: PoLineDetail = {
        lineId: r.PurchaseDetailID != null ? `pod:${r.PurchaseDetailID}` : "",
        partNumber: clean(r.PartNumber) || "—",
        desc: clean(r.PartDesc),
        qty,
        price: Number(r.PurchasePrice) || 0,
        orderedDate: iso(r.PurchaseDate),
        expectedDate: iso(r.DateRequired ?? r.PurchaseDateRequired),
        receivedQty,
        receivedDate: iso(r.LastReceivedDate),
        status: receivedQty >= qty ? "received" : "ordered",
      };
      let pos = byVendor.get(name);
      if (!pos) byVendor.set(name, (pos = new Map()));
      const arr = pos.get(poId);
      if (arr) arr.push(line);
      else pos.set(poId, [line]);
    }
    const vendors: Vendor[] = [];
    for (const [name, poMap] of byVendor) {
      const pos: PoLineGroup[] = [];
      for (const [poId, lines] of poMap) {
        const itemCount = lines.length;
        const received = lines.filter((l) => l.receivedQty >= l.qty).length;
        const pct = itemCount ? Math.round((received / itemCount) * 100) : 0;
        pos.push({ poId, itemCount, received, pct, lines });
      }
      vendors.push({ name, pos });
    }
    return vendors;
  } catch {
    return [];
  }
}

// ---------- Entry point ----------

export async function getJobBom(jobId: string): Promise<JobBom> {
  const empty: JobBom = {
    jobId: String(jobId),
    roots: [],
    grandTotalCost: 0,
    grandTotalPartQty: 0,
    rowCount: 0,
    vendors: [],
  };

  const numericJob = Number(String(jobId).replace(/[^0-9]/g, ""));
  if (!Number.isFinite(numericJob) || numericJob === 0) return empty;
  if (!config.user || !config.password) return empty;

  let specs: SpecRow[] = [];
  let tops: TopRow[] = [];
  let bomRows: BomRow[] = [];
  let poRows: PoRow[] = [];
  let pullRows: PullRow[] = [];
  let processRows: ProcessRow[] = [];
  try {
    // The SHARED pool, never closed — see totaleto-connection.ts. This used to open
    // mssql's global pool and close it in a finally, which is what let a BOM read
    // finishing mid-query abort somebody else's Total ETO request.
    //
    // Through withTotalEto since 2026-09-09 rather than totalEtoPool directly, so a
    // BOM walk gets the same bounded retries and the same per-attempt diagnostics as
    // every other Total ETO read. It also has to: `sql.Int` below is a type constant
    // from THIS module's copy of mssql, and only withTotalEto/totalEtoPool guarantee
    // a pool built by the same copy (see that file's note on the parameter-binding
    // failure this class of mistake caused).
    const [specR, topR, bomR, poR, pullR, procR] = await withTotalEto(
      async (pool) =>
        Promise.all([
          pool.request().input("job", sql.Int, numericJob).query(SPECS_SQL),
          pool.request().input("job", sql.Int, numericJob).query(TOP_SQL),
          pool.request().input("job", sql.Int, numericJob).query(BOM_SQL),
          pool.request().input("job", sql.Int, numericJob).query(PO_SQL),
          pool.request().input("job", sql.Int, numericJob).query(PULLS_SQL),
          pool.request().input("job", sql.Int, numericJob).query(PROCESS_SQL),
        ]),
      { requestTimeout: TOTALETO_TIMEOUT.bom, feed: "job_bom.walk" },
    );
    specs = specR.recordset as SpecRow[];
    tops = topR.recordset as TopRow[];
    bomRows = bomR.recordset as BomRow[];
    poRows = poR.recordset as PoRow[];
    pullRows = pullR.recordset as PullRow[];
    processRows = procR.recordset as ProcessRow[];
  } catch (error) {
    // ── An empty BOM and a failed BOM read looked identical (2026-09-09) ────
    //
    // This `catch` returned `empty` and said nothing, and Procurement renders an
    // empty BOM as a job with nothing left to buy. So any Total ETO fault here —
    // including the parameter-binding one that broke Parts cost for five days —
    // showed as a clean, confident, wrong answer.
    //
    // The return value is unchanged (every caller expects a JobBom, and inventing
    // an error channel through several components is a bigger change than this
    // finding warrants), but the reason now reaches the log with its diagnosis
    // rather than being discarded.
    console.error(`[job-bom] job ${jobId}: BOM read failed, returning an EMPTY bom. ${describeTotalEtoFailure(error)}`);
    return empty;
  }

  if (bomRows.length === 0) return empty;

  const ctx: BomContext = {
    poIndex: buildPoIndex(poRows),
    pulls: buildPullIndex(pullRows),
    processItems: new Set(processRows.map((r) => r.ItemID)),
  };
  const vendors = buildVendors(poRows); // fail-soft: [] on any error

  // Group rows + top nodes by SpecID.
  const rowsBySpec = new Map<number, BomRow[]>();
  for (const r of bomRows) {
    const arr = rowsBySpec.get(r.SpecID);
    if (arr) arr.push(r);
    else rowsBySpec.set(r.SpecID, [r]);
  }
  const topsBySpec = new Map<number, TopRow[]>();
  for (const tp of tops) {
    const arr = topsBySpec.get(tp.SpecID);
    if (arr) arr.push(tp);
    else topsBySpec.set(tp.SpecID, [tp]);
  }
  const specTitle = new Map<number, string>();
  for (const s of specs) specTitle.set(s.SpecID, clean(s.SDescription));

  // Order specs: known list first, then any leftover spec IDs that have rows.
  const specIds = [...new Set([...specs.map((s) => s.SpecID), ...rowsBySpec.keys()])].sort(
    (a, b) => a - b,
  );

  const roots: BomNode[] = [];
  let rowCount = 0;

  for (const specId of specIds) {
    const rows = rowsBySpec.get(specId);
    if (!rows || rows.length === 0) continue;
    const tree = buildSpecTree(rows);
    rowCount += tree.deduped.length;

    // Roots of this spec = the top node(s) from tblEngTop. Fall back to
    // parents that never appear as a child (reference buildTree.topParentIds).
    //
    // De-duplicated via a Set — `tblEngTop` has no unique constraint on
    // (ProjectID, ItemID) enforced at this layer, and a duplicate row there
    // used to reach `buildAssembly()` below unfiltered (unlike the fallback
    // branch three lines down, which was already Set-built). Two calls to
    // buildAssembly() with the identical `keyPath` produce two structurally
    // identical subtrees — the same assembly, part, and blocker rows twice,
    // with byte-identical keys — which is exactly the shape reported as
    // "duplicate assembly rows" in Build Readiness's What Can We Build Now.
    let topNodeIds = [...new Set((topsBySpec.get(specId) ?? []).map((tp) => tp.TopItemID))];
    topNodeIds = topNodeIds.filter((id) => tree.assemblyIds.has(id));
    if (topNodeIds.length === 0) {
      const childIds = new Set(tree.deduped.map((r) => r.ChildID));
      topNodeIds = [...tree.assemblyIds].filter((p) => !childIds.has(p));
    }

    // Flatten each top node's tree into the synthetic section node: the
    // section directly carries the top node(s)' assemblies + loose parts.
    const section: BomNode = {
      key: `S${specId}`,
      id: `S${specId}`,
      depth: 0,
      label: `Spec ${specId}`,
      pn: "",
      desc: specTitle.get(specId) ?? "",
      isAssembly: true,
      // A section is a synthetic container, never a purchased thing: it always
      // explodes into its contents and never carries its own buy line.
      release: "contentsOnly",
      self: null,
      // A section is synthetic - no eps edge - so it never carries a packet.
      packetId: null,
      packetLabel: null,
      stats: statsForRoots(topNodeIds, tree, ctx),
      children: [],
      parts: [],
      totalCost: 0,
      totalPartQty: 0,
      nestedAssemblies: 0,
    };

    for (const topId of topNodeIds) {
      // The top node is reached from tblEngTop, not from a BOM edge, so there is
      // no release status for it — and none is needed: a spec top is always
      // exploded (that is the only reason it exists).
      const top = buildAssembly(topId, "", "", `S${specId}/${topId}`, tree, ctx, new Set<number>(), null);
      section.children.push(...top.children);
      section.parts.push(...top.parts);
    }

    rollUp(section);
    if (section.children.length || section.parts.length) roots.push(section);
  }

  // Assign depth (section = 0).
  const setDepth = (n: BomNode, depth: number) => {
    n.depth = depth;
    for (const c of n.children) setDepth(c, depth + 1);
  };
  roots.forEach((r) => setDepth(r, 0));

  const grandTotalCost = roots.reduce((s, n) => s + n.totalCost, 0);
  const grandTotalPartQty = roots.reduce((s, n) => s + n.totalPartQty, 0);

  return { jobId: String(jobId), roots, grandTotalCost, grandTotalPartQty, rowCount, vendors };
}
