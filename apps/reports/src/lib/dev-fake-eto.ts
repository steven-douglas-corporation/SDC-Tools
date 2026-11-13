import "server-only";
import type { PartsCostLine, JobPartsCost } from "@/lib/sync-totaleto";
import { prisma } from "@/lib/prisma";

// ── Fake Total ETO parts feed, for LOCAL DEVELOPMENT ONLY (docs/DEV-ENVIRONMENT.md) ──
//
// Every parts-cost, left-to-invoice and parts-list number is computed from
// PartsCostLine rows fetched live from Total ETO — there is no table to seed. A dev
// machine has no Total ETO, so with SDC_DEV_FAKE_ETO=1 the parts functions in
// sync-totaleto.ts return the deterministic lines below instead of opening a SQL
// Server connection. Production never sets the flag, so none of this runs there.
//
// The lines are generated, per job, to hit the cases lib/left-to-invoice.ts and
// lib/parts-refund.ts exist to handle, so the invoicing logic has something to chew on:
//   • fully invoiced        • partially invoiced     • not yet invoiced
//   • BOM parts (BOM-…) and non-BOM parts (MISC-…)
//   • a refund (negative)   • an invoice billed but never posted to the GL (actual < invoiced)
//   • purchased in the LAST days of the previous month and in the current month
//     (the "purchased after the cutoff" rows the as-of logic must exclude)
//   • extra-cost lines with no PO (lineId "ec:…")
// Deterministic: the same job id always yields the same lines.

export function devFakeEtoEnabled(): boolean {
  return process.env.SDC_DEV_FAKE_ETO === "1";
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const SUPPLIERS = ["Acme DEV Fasteners", "Globex DEV Motion", "Initech DEV Electric", "Umbrella DEV Pneumatics", "Hooli DEV Sensors"];
const CATEGORIES = ["Fasteners", "Motion", "Electrical", "Pneumatics", "Sensors", "Raw Material"];

// ── Sample jobs: a LONG list, for pages that need one (Open POs) ───────────────────────
//
// The seeded dev database has seven jobs (prisma/seed-dev.ts, deliberately small), and every
// one of them gets the same eight POs from fakePartsLines below. That is enough to check the
// arithmetic and nothing like a real page: no long list of cards, no card with one PO beside
// one with twenty, no spread of dates. So Open POs (lib/open-pos.ts) adds these generated
// jobs to the ones in the database when the fake feed is on.
//
// They are NOT in the database, on purpose: seeding them would put thirty-odd empty jobs on
// every other dev page (Monthly ETC, the Dashboard, Projects). The cost is that a sample
// job's link to Job Details finds no job. Its POs, the PO panel and the BOM all work, since
// those are generated from the job number alone.
//
// SDC_DEV_FAKE_ETO_SAMPLE_JOBS sets how many (default 36, 0 for none, at most 80).

const SAMPLE_FIRST = 9101;
const SAMPLE_MAX = 80;
const isSampleJob = (n: number) => n >= SAMPLE_FIRST && n < SAMPLE_FIRST + SAMPLE_MAX;

const SAMPLE_MACHINES = [
  "Bottle Capper", "Weld Cell", "Leak Tester", "Palletizer", "Vision Inspection Cell", "Press Tending Cell", "Conveyor Retrofit",
  "Labeling Line", "Torque Station", "Kitting Cell", "Laser Marker", "Dispense Cell", "Assembly Dial", "Test Stand",
  "Tray Loader", "Bagging Line", "Riveting Station", "Deburr Cell", "Pick and Place Cell", "Screwdriving Station",
];

export function fakeSampleJobs(): { jobId: string; jobName: string; status: string }[] {
  const raw = process.env.SDC_DEV_FAKE_ETO_SAMPLE_JOBS;
  const asked = raw == null || raw.trim() === "" ? 36 : Math.floor(Number(raw));
  const count = Number.isFinite(asked) ? Math.max(0, Math.min(SAMPLE_MAX, asked)) : 0;
  return Array.from({ length: count }, (_, i) => {
    const round = Math.floor(i / SAMPLE_MACHINES.length);
    return {
      jobId: String(SAMPLE_FIRST + i),
      jobName: `DEV ${SAMPLE_MACHINES[i % SAMPLE_MACHINES.length]}${round ? ` ${round + 1}` : ""}`,
      // Mostly Active, some HeadStart: the two statuses Open POs lists.
      status: i % 7 === 3 ? "HeadStart" : "Active",
    };
  });
}

// A sample job's lines. Where the seven seeded jobs all look alike, these differ on purpose:
// from 1 PO to a couple of dozen, 1 to 6 lines each, bought any time in the last eight months
// with lead times from two weeks to four months, so expected dates run from long overdue to
// months out. Each PO is in one of four states (all received and invoiced, so not open;
// received and waiting on the invoice; partly received; nothing received yet), and a
// quarter of the outstanding lines have been re-promised. Deterministic per job, like the rest.
function sampleLines(n: number): PartsCostLine[] {
  const rand = seeded(n * 104729);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const now = new Date();
  const day = (base: Date, plus: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + plus);
  const seq = String(n - SAMPLE_FIRST + 1).padStart(2, "0");
  const out: PartsCostLine[] = [];
  // Skewed small: most jobs have a handful of POs, a few have a lot.
  const poCount = pick([1, 2, 2, 3, 3, 4, 5, 6, 7, 9, 11, 14, 18, 24]);
  let i = 0;

  for (let p = 0; p < poCount; p++) {
    const supplier = pick(SUPPLIERS);
    const purchased = day(now, -Math.floor(rand() * 240));
    const lead = 14 + Math.floor(rand() * 110);
    const lineCount = 1 + Math.floor(rand() * rand() * 6);
    const daysSince = Math.round((now.getTime() - purchased.getTime()) / 86_400_000);
    // Nothing bought this week has arrived; older POs are increasingly likely to be done.
    const roll = rand();
    const state: "closed" | "received" | "partial" | "open" =
      daysSince < 10 ? "open" : roll < 0.3 ? "closed" : roll < 0.45 ? "received" : roll < 0.65 ? "partial" : "open";
    const invDate = day(purchased, 5 + Math.floor(rand() * 25));
    const canInvoice = invDate <= now;

    for (let k = 0; k < lineCount; k++, i++) {
      const bom = rand() < 0.7;
      const qty = 1 + Math.floor(rand() * 40);
      const unit = r2(5 + rand() * 900);
      const gross = r2(qty * unit);
      const required = day(purchased, lead + Math.floor(rand() * 10));
      // Partial: the first line is here, the next half here, the rest not yet.
      const receivedQty = state === "closed" || state === "received" ? qty : state === "partial" ? (k === 0 ? qty : k === 1 ? Math.floor(qty / 2) : 0) : 0;
      const outstanding = receivedQty < qty;
      const expected = outstanding && rand() < 0.25 ? day(required, 7 + Math.floor(rand() * 36)) : required;
      const invoiced = state === "closed" && canInvoice ? gross : state === "partial" && canInvoice && k === 0 ? r2(gross * 0.4) : 0;
      out.push({
        lineId: `pod:${n * 1000 + i}`,
        itemId: null,
        purchaseDate: ymd(purchased),
        invoicedDate: invoiced ? ymd(invDate) : null,
        requiredDate: ymd(required),
        expectedDate: ymd(expected),
        receivedQty,
        supplier,
        manufacturer: null,
        category: pick(CATEGORIES),
        // Six characters, T for test data: T + the sample job's number (01 to 80) + the PO's
        // index on it (000 up), so T07012. The seeded jobs' start T9, so the two never clash.
        poNumber: `T${seq}${String(p).padStart(3, "0")}`,
        partNumber: bom ? `BOM-${n}-${String(i).padStart(3, "0")}` : `MISC-${String(i).padStart(3, "0")}`,
        description: bom ? "DEV BOM part" : "DEV non-BOM purchase",
        quantity: qty,
        unitPrice: unit,
        totalPrice: gross,
        invoicedAmount: invoiced,
        actualAmount: invoiced,
      });
    }
  }
  return out.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? ""));
}

export function fakePartsLines(jobId: string): PartsCostLine[] {
  const n = Number(jobId);
  if (!Number.isFinite(n)) return [];
  if (isSampleJob(n)) return sampleLines(n);
  const rand = seeded(n * 7919);
  const now = new Date();
  const out: PartsCostLine[] = [];
  const count = 24;

  for (let i = 0; i < count; i++) {
    // Spread purchases over ~5 months; the last few land in the final days of last
    // month and the first days of this one, straddling a month-end cutoff.
    const daysAgo = i < 4 ? Math.floor(rand() * 6) : 6 + Math.floor(rand() * 150);
    const purchased = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
    const bom = rand() < 0.6;
    const qty = 1 + Math.floor(rand() * 40);
    const unit = r2(5 + rand() * 900);
    const gross = r2(qty * unit);
    const scenario = i % 8; // deterministic coverage of each case
    let invoiced = 0;
    let actual = 0;
    let total = gross;
    let invDate: string | null = null;
    const lag = new Date(purchased.getFullYear(), purchased.getMonth(), purchased.getDate() + 5 + Math.floor(rand() * 25));
    const canInvoice = lag <= now;

    if (scenario <= 2 && canInvoice) {
      invoiced = gross; actual = gross; invDate = ymd(lag); // fully invoiced
    } else if (scenario === 3 && canInvoice) {
      invoiced = r2(gross * 0.4); actual = invoiced; invDate = ymd(lag); // partial: open balance remains in total
    } else if (scenario === 5 && canInvoice) {
      invoiced = gross; actual = r2(gross * 0.5); invDate = ymd(lag); // billed, only half posted to the GL
    } else if (scenario === 6 && canInvoice) {
      // refund / credit: negative against the line
      invoiced = -r2(gross * 0.25); actual = invoiced; total = -r2(gross * 0.25); invDate = ymd(lag);
    }
    // scenarios 4 and 7 (and anything not yet invoiceable): purchased, nothing invoiced

    // Delivery side, for Open POs. Derived from i and the scenario WITHOUT calling rand(),
    // so every value generated above (and every figure a test pins) is unchanged.
    //   invoiced in full / refund -> received; partial -> half received;
    //   scenario 4 -> received, waiting on the invoice; scenario 7 and not-yet-invoiceable -> not received.
    const required = new Date(purchased.getFullYear(), purchased.getMonth(), purchased.getDate() + 10 + ((i * 7) % 35));
    const receivedQty =
      scenario === 3 && canInvoice ? Math.floor(qty / 2) : scenario === 4 || (invoiced !== 0 && scenario !== 3) ? qty : 0;
    // Every fourth line the vendor has re-promised three weeks later (Total ETO's DateRevised),
    // so the dev page shows POs that are past their original date but not late.
    const expected = i % 4 === 1 ? new Date(required.getFullYear(), required.getMonth(), required.getDate() + 21) : required;

    out.push({
      lineId: `pod:${n * 1000 + i}`,
      // Fake lines carry no item id, so they take the part-number fallback join.
      itemId: null,
      purchaseDate: ymd(purchased),
      invoicedDate: invDate,
      requiredDate: ymd(required),
      expectedDate: ymd(expected),
      receivedQty,
      // One supplier per PO (lines i, i+1, i+2 share a PO number below), as on a real PO. The
      // draw is kept and discarded so every later rand() value, and every figure, is unchanged.
      supplier: (rand(), SUPPLIERS[(n + Math.floor(i / 3)) % SUPPLIERS.length]),
      manufacturer: null,
      category: CATEGORIES[Math.floor(rand() * CATEGORIES.length)],
      // Six characters like a real PO number (106836), with T marking it as test data:
      // T + the 4-digit job + the PO's index on it (8 POs a job, 0-7), so T90041.
      poNumber: `T${String(n).padStart(4, "0").slice(-4)}${Math.floor(i / 3)}`,
      partNumber: bom ? `BOM-${n}-${String(i).padStart(3, "0")}` : `MISC-${String(i).padStart(3, "0")}`,
      description: bom ? "DEV BOM part" : "DEV non-BOM purchase",
      quantity: scenario === 6 ? -qty : qty,
      unitPrice: unit,
      totalPrice: total,
      invoicedAmount: invoiced,
      actualAmount: actual,
    });
  }

  // Extra costs: no PO, no part number (freight, expediting).
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 10 + i);
    const amt = r2(150 + rand() * 600);
    out.push({
      lineId: `ec:${n}:${i}:${amt}`, itemId: null, purchaseDate: ymd(d), invoicedDate: ymd(d), supplier: "DEV Freight", manufacturer: null,
      category: "Extra Cost", poNumber: null, partNumber: null, description: "DEV freight / expedite", quantity: 1, unitPrice: amt,
      totalPrice: amt, invoicedAmount: amt, actualAmount: amt,
    });
  }
  return out.sort((a, b) => (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? ""));
}

const inWindow = (day: string | null, start: Date, endExcl: Date) => !!day && day >= ymd(start) && day < ymd(endExcl);

function toJobPartsCost(lines: PartsCostLine[]): JobPartsCost {
  const purchased = lines.reduce((s, l) => s + l.totalPrice, 0);
  const paid = lines.reduce((s, l) => s + l.invoicedAmount, 0);
  const actual = lines.reduce((s, l) => s + l.actualAmount, 0);
  return { purchased, paid, actual, leftToPay: purchased - paid, lines };
}

export function fakeJobPartsCost(jobId: string): JobPartsCost {
  return toJobPartsCost(fakePartsLines(jobId));
}

export function fakeJobPartsInvoicedInMonth(jobId: string, start: Date, endExcl: Date): JobPartsCost {
  return toJobPartsCost(fakePartsLines(jobId).filter((l) => inWindow(l.invoicedDate, start, endExcl)));
}

async function devJobIds(): Promise<string[]> {
  const rows = await prisma.job.findMany({ select: { jobId: true } });
  return rows.map((r) => r.jobId).filter((j) => Number.isFinite(Number(j)));
}

async function sumByJob(pick: (lines: PartsCostLine[]) => number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of await devJobIds()) {
    const v = pick(fakePartsLines(id));
    if (v !== 0) out.set(String(Number(id)), r2(v));
  }
  return out;
}

export const fakePartsActualByJob = () => sumByJob((ls) => ls.reduce((s, l) => s + l.actualAmount, 0));
export const fakePartsInvoicedByJob = (start: Date, endExcl: Date) =>
  sumByJob((ls) => ls.filter((l) => inWindow(l.invoicedDate, start, endExcl)).reduce((s, l) => s + l.invoicedAmount, 0));
export const fakePartsPurchasedByJob = (start: Date, endExcl: Date) =>
  sumByJob((ls) => ls.filter((l) => inWindow(l.purchaseDate, start, endExcl)).reduce((s, l) => s + l.quantity * l.unitPrice, 0));
