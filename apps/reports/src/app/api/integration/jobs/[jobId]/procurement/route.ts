import type { NextRequest } from "next/server";
import { getJobBom } from "@/lib/job-bom";
import { getJobPartsCost, type PartsCostLine } from "@/lib/sync-totaleto";
import { flattenBomParts, type FlatPart, type PoGroup } from "@/lib/po-detail";
import { computeRiskCards, earliestRequired, UPCOMING_WEEKS } from "@/lib/procurement-risk";
import { checkSchedulerToken } from "@/lib/scheduler-api-auth";

// The three procurement risk cards for one job — Delivery Slip, No Purchase
// Order, Upcoming Deliveries — exactly as this app's Job Hours Details page
// renders them. Read-only, server-to-server, same SCHEDULER_SHARED_TOKEN guard
// as its sibling endpoints.
//
// ── Why this exists (2026-08-26) ────────────────────────────────────────────
// The Build Readiness app (apps/build-readiness) shows three cards with these
// same three titles, and they disagreed with this page for every job. They were
// a second, independent implementation computed in the browser off Build
// Readiness's own PO action list, and each of the three was wrong in its own
// way — see procurement-risk.ts's header for the specific defects.
//
// Rather than porting the rules a second time (a third implementation, free to
// drift again), Build Readiness now reads them from here. That follows the
// precedent already set for hours: consumers read this app's
// /api/integration/* endpoints instead of re-deriving from the upstream
// system. Everything served below comes from `computeRiskCards`, the same
// function JobProcurement.tsx calls — this route adds a wire format, not a
// rule.
//
// ── Why the input has to be BOM + parts-cost lines, not just the BOM ────────
// `flattenBomParts` fills a part's `poNumber` from `p.poId ?? line.poNumber`
// and its `supplier` from `p.supplier ?? line.supplier`. Delivery Slip's own
// eligibility tests `poNumber`, so dropping the parts-cost lines would quietly
// shrink that card relative to the page. They are fetched here for that reason
// alone; the money fields they also carry are not serialised.
function toDay(s: string | null): string | null {
  return s ? s.slice(0, 10) : null;
}

// ── Wire format ─────────────────────────────────────────────────────────────
// A deliberately narrow projection of FlatPart: identity, dates, quantity,
// price and the derived status key. Not the whole object — `FlatPart` carries
// this app's Power BI money fields (invoicedAmount, leftToSpend, pctInvoiced),
// which are none of a build-readiness consumer's business and would make this
// endpoint a second, unaudited path to cost data.
//
// Dates are day-precision ISO (`YYYY-MM-DD`). The full timestamps are an
// artefact of Total ETO's datetime columns, not real times of day, and
// day-precision is what stops a consumer in another timezone from rendering a
// part as due the previous evening.
type WirePart = {
  id: number;
  pn: string;
  desc: string;
  qty: number;
  receivedQty: number;
  unitPrice: number;
  supplier: string | null;
  poNumber: string | null;
  requiredDate: string | null;
  expectedDate: string | null;
  poDate: string | null;
  status: FlatPart["st"]["key"];
  hold: boolean;
  parentPN: string;
  parentDesc: string;
  sectionLabel: string;
};

type WirePoRow = {
  supplier: string;
  poNumber: string | null;
  partCount: number;
  received: number;
  expected: string | null;
  required: string | null;
  pastDue: boolean;
  parts: WirePart[];
};

function wirePart(p: FlatPart): WirePart {
  return {
    id: p.id,
    pn: p.pn,
    desc: p.desc,
    qty: p.qty,
    receivedQty: p.receivedQty,
    unitPrice: p.unitPrice,
    supplier: p.supplier,
    poNumber: p.poNumber,
    requiredDate: toDay(p.requiredDate),
    expectedDate: toDay(p.expectedDate),
    poDate: toDay(p.poDate),
    status: p.st.key,
    hold: p.hold,
    parentPN: p.parentPN,
    parentDesc: p.parentDesc,
    sectionLabel: p.sectionLabel,
  };
}

function wirePoRow(row: { supplier: string; po: PoGroup }): WirePoRow {
  return {
    supplier: row.supplier,
    poNumber: row.po.poNumber,
    partCount: row.po.total,
    received: row.po.received,
    expected: toDay(row.po.expected),
    required: toDay(earliestRequired(row.po.parts)),
    pastDue: row.po.pastDue,
    parts: row.po.parts.map(wirePart),
  };
}

export async function GET(
  req: NextRequest,
  ctx: RouteContext<"/api/integration/jobs/[jobId]/procurement">,
) {
  const denied = checkSchedulerToken(req);
  if (denied) return denied;

  const { jobId } = await ctx.params;
  const numericJob = Number(String(jobId).replace(/[^0-9]/g, ""));
  if (!Number.isFinite(numericJob) || numericJob === 0) {
    return Response.json({ error: `Invalid job id: ${jobId}` }, { status: 400 });
  }

  // `getJobBom` is already fail-soft (an empty JobBom on any upstream error).
  // The parts-cost side is not, and it is the less important of the two — it
  // only enriches supplier/PO number — so a failure there degrades to `[]`
  // rather than failing the request. That is disclosed to the consumer as
  // `partsLinesAvailable: false` instead of being swallowed silently: with no
  // lines, a part whose PO number is known ONLY to the parts-cost feed drops
  // out of Delivery Slip, and a consumer comparing against the page needs to
  // be able to see that that is why.
  let lines: PartsCostLine[] = [];
  let partsLinesAvailable = true;
  const [bom, partsCost] = await Promise.all([
    getJobBom(String(numericJob)),
    getJobPartsCost(String(numericJob)).catch((e) => {
      console.error(`procurement route: getJobPartsCost failed for job ${numericJob}:`, e);
      return null;
    }),
  ]);
  if (partsCost) lines = partsCost.lines;
  else partsLinesAvailable = false;

  if (bom.roots.length === 0) {
    return Response.json(
      { error: `No BOM found for job ${numericJob}` },
      { status: 404 },
    );
  }

  const parts = flattenBomParts(bom, lines);
  // One `now` for the whole computation. Reading the clock per card could put
  // two cards on opposite sides of midnight.
  const now = Date.now();
  const risk = computeRiskCards(parts, now);

  return Response.json({
    jobId: String(numericJob),
    generatedAt: new Date(now).toISOString(),
    partsLinesAvailable,
    requirementCount: parts.length,
    upcomingWeeks: UPCOMING_WEEKS,
    deliverySlip: {
      partCount: risk.delivery.length,
      avgLateDays: risk.deliveryAvgLate,
      oldestRequired: toDay(risk.deliveryOldest),
      parts: risk.delivery.map(wirePart),
      pos: risk.deliveryPos.map(wirePoRow),
    },
    noPo: {
      partCount: risk.noPo.length,
      thisWeek: risk.noPoThisWeek,
      oldestRequired: toDay(risk.noPoOldest),
      parts: risk.noPoSorted.map(wirePart),
      pos: risk.noPoPos.map(wirePoRow),
    },
    upcoming: {
      partCount: risk.upcoming.length,
      parts: risk.upcoming.map(wirePart),
      pos: risk.upcomingAllPos.map(wirePoRow),
      weeks: risk.weekData.map((w) => ({
        week: w.week,
        count: w.count,
        parts: w.parts.map(wirePart),
      })),
    },
  });
}
