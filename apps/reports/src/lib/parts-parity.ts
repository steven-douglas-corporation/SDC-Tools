import "server-only";
import { prisma } from "@/lib/prisma";
import { PARTS_COST_SECTION } from "@/lib/sections";
import { getPartsCostForJobs, getJobPartsInvoicedInMonth } from "@/lib/sync-totaleto";
import { getJobBom } from "@/lib/job-bom";
import { flattenBomParts } from "@/lib/po-detail";
import { rewindLines, monthEndCutoff } from "@/lib/left-to-invoice";
import { attributeInvoicedWindow, collectBomPartNumbers, collectBomItemIds } from "@/lib/parts-cost-window-attribution";
import { monthWindowUtc } from "@/lib/etc";
import type { JobAnalysis } from "@/lib/job-analysis";

// ── Safeguard: shared figures vs the Job Details Parts List ──────────────────
//
// Analysis and Monthly ETC read one source (lib/parts-month-figures.ts). The Parts List
// does not — it is built BOM-first, per job. So this rebuilds the Parts List's two
// footer figures for every job, exactly as the page does, and reports each job where
// they differ from the shared figure. It also compares the Money Spent Monthly ETC has
// STORED against the shared (live) figure, which catches a stale sync.
//
//   Left to Invoice  Parts List in PM mode: BOM + lines rewound to month end.
//   Money Spent      Parts List with the Invoiced date range = the whole month.
//
// Read-only. Slow by nature (one BOM read per job), so it runs on demand, not on load.

export type ParityMismatch = {
  jobId: string;
  figure: "Left to Invoice" | "Money Spent";
  against: "Parts List" | "Monthly ETC (stored)";
  shared: number;
  other: number;
};

export type ParityReport = {
  month: string;
  checkedJobs: number;
  mismatches: ParityMismatch[];
  /** Jobs whose Parts List could not be rebuilt — unchecked, never reported as matching. */
  unchecked: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const differs = (a: number, b: number) => Math.abs(a - b) >= 0.01;

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export async function checkPartsParity(analysis: JobAnalysis): Promise<ParityReport> {
  const { month, rows } = analysis;
  const mismatches: ParityMismatch[] = [];
  const unchecked: string[] = [];

  const jobs = await prisma.job.findMany({ where: { jobId: { in: rows.map((r) => r.jobId) } }, select: { id: true, jobId: true } });
  const pkByNumber = new Map(jobs.map((j) => [j.jobId, j.id]));
  const entries = await prisma.etcEntry.findMany({
    where: { month, section: PARTS_COST_SECTION, jobId: { in: jobs.map((j) => j.id) } },
    select: { jobId: true, hoursWorked: true },
  });
  const storedByPk = new Map(entries.map((e) => [e.jobId, r2(Number(e.hoursWorked))]));

  const END = monthEndCutoff(month);
  if (!END) throw new Error(`parts parity: bad month ${month}`);
  const { start, endExclusive } = monthWindowUtc(month);
  const linesByJob = await getPartsCostForJobs(rows.map((r) => r.jobId));

  await pool(rows, 3, async (row) => {
    try {
      const bom = await getJobBom(row.jobId);
      const lines = linesByJob.get(row.jobId) ?? [];

      // Left to Invoice: the Parts List in PM mode.
      const pm = flattenBomParts(bom, rewindLines(lines, END), null);
      const listLti = r2(pm.reduce((s, p) => s + (p.leftToSpend ?? 0), 0));
      if (row.leftToInvoice !== null && differs(row.leftToInvoice, listLti)) {
        mismatches.push({ jobId: row.jobId, figure: "Left to Invoice", against: "Parts List", shared: row.leftToInvoice, other: listLti });
      }

      // Money Spent: the Parts List with the Invoiced date range set to the month.
      const win = await getJobPartsInvoicedInMonth(row.jobId, start, endExclusive);
      const attr = attributeInvoicedWindow(win.lines, collectBomPartNumbers(bom.roots), collectBomItemIds(bom.roots));
      const listSpent = r2(flattenBomParts(bom, lines, attr).reduce((s, p) => s + p.invoicedAmount, 0));
      if (row.moneySpent !== null && differs(row.moneySpent, listSpent)) {
        mismatches.push({ jobId: row.jobId, figure: "Money Spent", against: "Parts List", shared: row.moneySpent, other: listSpent });
      }

      // Monthly ETC's stored Money Spent (a snapshot written by the sync).
      const stored = storedByPk.get(pkByNumber.get(row.jobId) ?? -1);
      if (stored !== undefined && row.moneySpent !== null && differs(row.moneySpent, stored)) {
        mismatches.push({ jobId: row.jobId, figure: "Money Spent", against: "Monthly ETC (stored)", shared: row.moneySpent, other: stored });
      }
    } catch (err) {
      console.error(`[parts-parity] ${row.jobId}:`, err);
      unchecked.push(row.jobId);
    }
  });

  return { month, checkedJobs: rows.length - unchecked.length, mismatches, unchecked };
}
