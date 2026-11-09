import "server-only";
import sql from "mssql";
import { withTotalEto, describeTotalEtoFailure } from "@/lib/totaleto-connection";
import { devFakeEtoEnabled } from "@/lib/dev-fake-eto";
import { fakeBomRecordsets } from "@/lib/dev-fake-bom";

// ── Where one PO's parts sit in the BOM, read when someone opens that PO ─────────
//
// Open POs loads only PO lines (one batched read for every job). Where each part is used,
// which assembly, when it is needed and whether engineering has it on hold, lives in the BOM,
// and walking every job's BOM to draw the page would take minutes (see job-bom.ts). So this
// is asked for one PO, on click: the BOM rows whose part is on that PO, in the job the PO
// line charges. It is a BOM lookup keyed by a PO, not a second source of PO money: every
// figure in the panel still comes from the parts feed.

export type PoBomUse = {
  /** `pod:<PurchaseDetailID>`, matching OpenPoLine.lineId. */
  lineId: string;
  section: string;
  assemblyPn: string;
  assemblyDesc: string;
  /** Quantity the BOM needs under this assembly. */
  qty: number;
  /** When the BOM needs it, `YYYY-MM-DD`. */
  neededBy: string | null;
  onHold: boolean;
};

export type PoBomContext = { ok: true; uses: PoBomUse[] } | { ok: false; error: string };

const PO_BOM_SQL = `
  SELECT
    pod.PurchaseDetailID,
    eps.SpecID,
    s.SDescription,
    parent.ItemCompanyID   AS AssemblyPN,
    parent.ItemDescription AS AssemblyDesc,
    eps.ItemQty,
    CONVERT(varchar(10), eps.RequiredDate, 23) AS NeededBy,
    eps.ItemHold
  FROM tblPurchaseOrderDetails pod WITH (NOLOCK)
  JOIN tblEngProductStructure eps WITH (NOLOCK) ON eps.ProjectID = pod.ProjectID AND eps.ChildID = pod.ItemID
  JOIN tblEngItemMaster parent WITH (NOLOCK) ON parent.ItemID = eps.ParentID
  LEFT JOIN tblSpec s WITH (NOLOCK) ON s.ProjectID = eps.ProjectID AND s.SpecID = eps.SpecID
  WHERE pod.PurchaseOrderID = @po
  ORDER BY pod.PurchaseDetailID, eps.SpecID, parent.ItemCompanyID`;

type Row = {
  PurchaseDetailID: number;
  SpecID: number | null;
  SDescription: string | null;
  AssemblyPN: string | null;
  AssemblyDesc: string | null;
  ItemQty: number | null;
  NeededBy: string | null;
  ItemHold: boolean | number | null;
};

const sectionLabel = (spec: number | null, title: string | null) => [spec != null ? `Section ${spec}` : "", (title ?? "").trim()].filter(Boolean).join(" · ");

export async function getPoBomContext(poNumber: string, jobIds: readonly string[]): Promise<PoBomContext> {
  if (devFakeEtoEnabled()) return { ok: true, uses: fakeUses(poNumber, jobIds) };
  // Total ETO's PO number is tblPurchaseOrderHeader.PurchaseOrderID, an integer.
  if (!/^\d{1,10}$/.test(poNumber)) return { ok: true, uses: [] };
  try {
    const result = await withTotalEto((pool) => pool.request().input("po", sql.Int, Number(poNumber)).query(PO_BOM_SQL), {
      requestTimeout: 20_000,
      feed: "open_pos.po_bom",
    });
    const uses = (result.recordset as Row[]).map((r) => ({
      lineId: `pod:${r.PurchaseDetailID}`,
      section: sectionLabel(r.SpecID, r.SDescription),
      assemblyPn: (r.AssemblyPN ?? "").trim(),
      assemblyDesc: (r.AssemblyDesc ?? "").trim(),
      qty: Number(r.ItemQty) || 0,
      neededBy: r.NeededBy ?? null,
      onHold: !!r.ItemHold,
    }));
    return { ok: true, uses };
  } catch (error) {
    console.error(`[open-pos] BOM lookup for PO ${poNumber} failed: ${describeTotalEtoFailure(error)}`);
    return { ok: false, error: "Could not read the BOM from Total ETO. The PO's lines are still shown." };
  }
}

// Dev: the same answer from the fake BOM, so the panel's BOM column has data locally.
function fakeUses(poNumber: string, jobIds: readonly string[]): PoBomUse[] {
  const out: PoBomUse[] = [];
  for (const job of jobIds) {
    const n = Number(job);
    if (!Number.isFinite(n)) continue;
    const { poRows, bomRows, specs } = fakeBomRecordsets(n);
    const title = new Map(specs.map((s) => [s.SpecID, s.SDescription]));
    for (const po of poRows.filter((p) => String(p.PurchaseOrderID) === poNumber)) {
      for (const b of bomRows.filter((r) => r.ChildID === po.ItemID)) {
        out.push({
          lineId: `pod:${po.PurchaseDetailID}`,
          section: sectionLabel(b.SpecID, title.get(b.SpecID) ?? null),
          assemblyPn: b.ParentPN ?? "",
          assemblyDesc: b.ParentDesc ?? "",
          qty: Number(b.ItemQty) || 0,
          neededBy: b.RequiredDate ? b.RequiredDate.toISOString().slice(0, 10) : null,
          onHold: !!b.ItemHold,
        });
      }
    }
  }
  return out;
}
