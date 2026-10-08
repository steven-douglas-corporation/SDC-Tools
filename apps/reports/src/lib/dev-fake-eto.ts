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

export function fakePartsLines(jobId: string): PartsCostLine[] {
  const n = Number(jobId);
  if (!Number.isFinite(n)) return [];
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

    out.push({
      lineId: `pod:${n * 1000 + i}`,
      // Fake lines carry no item id, so they take the part-number fallback join.
      itemId: null,
      purchaseDate: ymd(purchased),
      invoicedDate: invDate,
      supplier: SUPPLIERS[Math.floor(rand() * SUPPLIERS.length)],
      manufacturer: null,
      category: CATEGORIES[Math.floor(rand() * CATEGORIES.length)],
      poNumber: `DEV-PO-${n}-${100 + Math.floor(i / 3)}`,
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
