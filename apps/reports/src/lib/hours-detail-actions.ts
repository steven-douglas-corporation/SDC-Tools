"use server";

import { auth } from "@/lib/auth";
import { isValidMonth, monthWindowUtc } from "@/lib/etc";
import { getEtcMonthHoursDetail, type JobHoursDetail } from "@/lib/job-hours-detail";
import { getPartsSpentDetail, type PartsSpentDetail } from "@/lib/parts-spent";
import { getJobPartsInvoicedInMonth, type JobPartsCost } from "@/lib/sync-totaleto";
import { withDrillErrors } from "@/lib/drill-error";

// The punch drill-through behind the Monthly ETC cards, fetched WHEN IT IS OPENED.
//
// ── Why this action exists (2026-08-04, performance pass) ────────────────────
//
// The ETC page used to load this with the page, every single time, for a panel that
// is CLOSED until somebody clicks "Detail". Measured on 2026-07 (49 jobs):
//
//     1,092 punch rows + the whole 120-row employee roster
//     46ms of database time — the single slowest query on the page
//     serialised into the RSC payload of every render
//
// "Every render" is the part that hurts. The route is re-rendered far more often
// than it is navigated to: a background refresh every 45s, a refetch on focus, one
// per filter change, and — until this same pass — one per realtime change event
// from any colleague. So the cost of a panel nobody had opened was being paid tens
// of times per session, on the heaviest page in the app.
//
// The unattributed-hours drill on the same strip already worked this way, with the
// reason stated in EtcMonthKpiCards: "fetched on click, not with the page —
// re-parsing it on every open would make the panel feel broken". This is the same
// judgement applied to the bigger of the two datasets.
//
// Behaviour is unchanged once open: same function, same scoping to the jobs the
// grid is rendering, same MAX_ROWS truncation flag.
export async function loadEtcMonthHoursDetail(month: string, jobIds: number[]): Promise<JobHoursDetail> {
  // Signed-in only. Every page is already behind auth (the (app) layout awaits it),
  // but a server action is a public endpoint of its own and has to say so itself.
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!isValidMonth(month)) throw new Error(`Invalid month "${month}".`);
  // The caller passes the jobs the grid is rendering, so the drill matches the card
  // that opened it. Validated rather than trusted: these go straight into a WHERE
  // clause, and an unbounded list from a hand-posted request would be a way to ask
  // for the entire punch table. The cap is far above any real month (the ETC grid
  // renders ~50 jobs).
  const ids = jobIds.filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  if (ids.length === 0) return { rows: [], total: 0, sections: [], truncated: false };
  return getEtcMonthHoursDetail(month, ids);
}

// The same treatment for the "Parts spent" card, which until now was the one figure on
// the strip with nothing behind it. Fetched on open, scoped to the jobs the grid is
// rendering, and validated identically — a server action is a public endpoint whatever
// the component that calls it looks like.
export async function loadPartsSpentDetail(month: string, jobIds: number[]): Promise<PartsSpentDetail> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!isValidMonth(month)) throw new Error(`Invalid month "${month}".`);
  const ids = jobIds.filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  return getPartsSpentDetail(month, ids);
}

// ── The SECOND level: what one job's parts money was actually spent on ───────
//
// "Job 1142 spent $113,101 in July" is where the first level stops, and it is not
// where the question stops — the next thing anybody asks is what was bought. This
// returns the individual AP-document lines behind that figure: supplier, part number,
// description, quantity, and what was invoiced.
//
// ── Windowed to the SAME month as the row above it, at the AP-document grain
// (fixed 2026-08-07) ─────────────────────────────────────────────────────────────
//
// This used to reuse getJobPartsCost (the Job Hour Details page's whole-purchase-
// -history query), unwindowed, with a sentence explaining the lines wouldn't sum to
// the month's figure above them. Reported as a bug: a job's one big invoice from a
// different month showed up as a line under this month's small total.
//
// A first attempt filtered getJobPartsCost's lines by "does this line's invoiced date
// fall in the month" — also wrong, and in a subtler way: that function's invoicedDate/
// invoicedAmount are a LIFETIME aggregate per PO line (grouped by PurchaseDetailID
// alone), so a line invoiced across several different months would have dumped its
// ENTIRE cumulative total into whichever one happened to contain its latest invoice.
//
// getJobPartsInvoicedInMonth (lib/sync-totaleto.ts) is a genuinely different, separate
// query: it joins the AP document tables directly and filters by APBD.APDocDate BEFORE
// aggregating, one row per actual invoice event in the window — the same basis
// getPartsCostBookedByJob windows the row's own "Money spent" figure on, and Extra
// Costs excluded to match that figure's own scope. Every row it returns already has a
// real invoiced amount by construction (it comes from an AP document), so there is no
// separate invoiced-only filter step here the way getJobPartsCost's callers need.
export async function loadJobPartsLines(jobNumber: string, month: string): Promise<JobPartsCost> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  // Job numbers are digits in this app ("1142"); anything else is a crafted request,
  // and this value reaches a SQL parameter.
  if (!/^\d{1,10}$/.test(jobNumber)) throw new Error(`Invalid job number "${jobNumber}".`);
  if (!isValidMonth(month)) throw new Error(`Invalid month "${month}".`);
  const { start, endExclusive } = monthWindowUtc(month);
  // ── Total ETO failures become a sentence, not React's redaction ───────────
  //
  // This is the ONE action on this page that leaves the application database, so
  // it is the one that can fail because an integration is down rather than
  // because of anything the user did. Unwrapped, a ConnectionError escaped the
  // action and Next replaced it with "An error occurred in the Server Components
  // render..." — printed verbatim into the parts table on 2026-09-01, when the
  // Total ETO credentials stopped working (ELOGIN). See lib/drill-error.ts.
  return withDrillErrors({
    metric: "etc.partsSpent.jobLines",
    context: { jobNumber, month },
    upstream: "totaleto",
    run: () => getJobPartsInvoicedInMonth(jobNumber, start, endExclusive),
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Open-ended sentinel bounds — same convention this file's own callers of
// getPartsCostSpentByJob already used for a "lifetime" window before that
// function was fixed to drop its date params entirely (see sync-totaleto.ts).
const OPEN_START = new Date(Date.UTC(1990, 0, 1));
const OPEN_END = new Date(Date.UTC(2100, 0, 1));

// ── Parts List's own "Invoiced" + date-range filter, reusing the ETC drill's
// already-verified query (2026-08-09) ────────────────────────────────────────
//
// Job Hour Details → Parts List had never received the fix loadJobPartsLines/
// getJobPartsInvoicedInMonth got above: its own date-range picker filtered
// getJobPartsCost's LIFETIME, PurchaseDetailID-collapsed invoicedAmount by a
// row's single most-recent invoice date, showing the wrong figure for the
// exact reason described in the comment above this function. This calls the
// SAME already-correct, already-tested query loadJobPartsLines uses — its
// window was never actually restricted to a calendar month (nothing in
// getJobPartsInvoicedInMonth's own implementation assumes one), so reusing it
// for an arbitrary toolbar-picked range is safe and is what keeps this
// reconciling to the cent with the ETC drill: same function, same query, same
// tested attribution rule — not a new, unverified one.
//
// JobProcurement.tsx (the Parts List client component) re-groups this
// function's line-level result by PART NUMBER via
// lib/parts-cost-window-attribution.ts's attributeInvoicedWindow — see that
// file for why part number, not PurchaseDetailID, is the right join key here.
export async function loadPartsListInvoicedInWindow(jobNumber: string, from: string, to: string): Promise<JobPartsCost> {
  const session = await auth();
  if (!session?.user) throw new Error("Not signed in.");
  if (!/^\d{1,10}$/.test(jobNumber)) throw new Error(`Invalid job number "${jobNumber}".`);
  if (from && !ISO_DATE.test(from)) throw new Error(`Invalid "from" date "${from}".`);
  if (to && !ISO_DATE.test(to)) throw new Error(`Invalid "to" date "${to}".`);
  if (!from && !to) throw new Error("A date range is required.");
  const start = from ? new Date(`${from}T00:00:00.000Z`) : OPEN_START;
  // `to` is inclusive of its whole day, so the exclusive bound is the NEXT day —
  // the same half-open-window reasoning monthWindowUtc's own comment gives for
  // why a month's end bound is "< the 1st of the next month", not "<= the 31st".
  const endExclusive = to ? new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) : OPEN_END;
  return getJobPartsInvoicedInMonth(jobNumber, start, endExclusive);
}
