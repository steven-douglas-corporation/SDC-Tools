import "server-only";
import { withTotalEto, describeTotalEtoFailure } from "@/lib/totaleto-connection";
import { devFakeEtoEnabled } from "@/lib/dev-fake-eto";
import { fakeBomRecordsets } from "@/lib/dev-fake-bom";

// ── When each PO line last had something received, for the Open POs timeline ─────────────
//
// The parts feed (sync-totaleto.ts) carries how much of a line has arrived (ReceivedQty, from
// vwReceiverLogSummed) but not when. The timeline marks a partly received PO's latest receipt,
// so this reads the date from Total ETO's receiver log for the lines the page already has: the
// same table and column Job Details (job-bom.ts) and the Scheduler (etoDb.js LastReceivedDate)
// read. A separate, batched lookup after the page draws, like the BOM's required dates
// (open-po-bom.ts getRequiredDates), so the shared money feed is untouched. The ids are
// validated integers (`pod:<PurchaseDetailID>`) and go in as literal IN lists in chunks.

export type ReceivedDates = { ok: true; byLine: Record<string, string> } | { ok: false; error: string };

const CHUNK = 900;
const receivedSql = (ids: number[]) => `
  SELECT rl.PurchaseDetailID, CONVERT(varchar(10), MAX(rl.[Date]), 23) AS LastReceived
  FROM tblReceiverLog rl WITH (NOLOCK)
  WHERE rl.PurchaseDetailID IN (${ids.join(",")})
    AND rl.[Date] IS NOT NULL
  GROUP BY rl.PurchaseDetailID`;

export async function getReceivedDates(detailIds: readonly number[]): Promise<ReceivedDates> {
  const ids = [...new Set(detailIds.filter((n) => Number.isSafeInteger(n) && n > 0))];
  if (devFakeEtoEnabled()) return { ok: true, byLine: fakeReceived(ids) };
  if (!ids.length) return { ok: true, byLine: {} };
  try {
    const byLine: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const result = await withTotalEto((pool) => pool.request().query(receivedSql(chunk)), {
        requestTimeout: 30_000,
        feed: "open_pos.received_dates",
      });
      for (const r of result.recordset as { PurchaseDetailID: number; LastReceived: string | null }[]) {
        if (r.LastReceived) byLine[`pod:${r.PurchaseDetailID}`] = r.LastReceived;
      }
    }
    return { ok: true, byLine };
  } catch (error) {
    console.error(`[open-pos] received dates for ${ids.length} lines failed: ${describeTotalEtoFailure(error)}`);
    return { ok: false, error: "Could not read received dates from Total ETO." };
  }
}

// Dev: the fake BOM's receipt dates (dev-fake-bom.ts LastReceivedDate), joined by line id like
// open-po-bom.ts's fakeRequired. The fake line id is `pod:<job * 1000 + index>`.
function fakeReceived(ids: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  const want = new Set(ids);
  for (const job of new Set(ids.map((id) => Math.floor(id / 1000)))) {
    for (const po of fakeBomRecordsets(job).poRows) {
      if (po.PurchaseDetailID == null || !want.has(po.PurchaseDetailID) || !po.LastReceivedDate) continue;
      out[`pod:${po.PurchaseDetailID}`] = po.LastReceivedDate.toISOString().slice(0, 10);
    }
  }
  return out;
}
