import "server-only";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { previousMonthKey } from "@/lib/still-to-purchase";

// ── Last month's "Left to Purchase", straight off the Monthly ETC tab ────────
//
// The manager types Left to Purchase (on the BOM, not bought yet) into each month's Parts Cost row.
// "Still to purchase" now starts from the PREVIOUS month's figure and takes this month's purchases off
// it (lib/still-to-purchase.ts). A missing row or a blank cell is null — not zero: an unanswered cell
// must fall back to the older estimate rather than read as "nothing left to buy".

export async function readLeftToPurchaseLastMonth(
  jobPks: number[],
  etcMonth: string | null,
): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  const prev = etcMonth ? previousMonthKey(etcMonth) : null;
  if (jobPks.length === 0 || !prev) return out;
  const rows = await prisma.etcEntry.findMany({
    where: { jobId: { in: jobPks }, section: PARTS_COST_SECTION, month: prev },
    select: { jobId: true, leftToPurchase: true },
  });
  for (const r of rows) out.set(r.jobId, r.leftToPurchase == null ? null : Number(r.leftToPurchase));
  return out;
}
