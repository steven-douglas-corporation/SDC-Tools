import fs from "fs";

type Row = {
  jobId: string;
  phase: string;
  costCode: string;
  glAcct: string;
  trxDate: string;
  desc: string;
  jrnl: string;
  ref: string;
  debit: number;
  credit: number;
};

function parseNum(s: string): number {
  if (!s) return 0;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

const text = fs.readFileSync("D:\\AI Projects\\sdc-etc-planner\\scripts\\archive\\_1116_dump_Job_Ledger.tsv", "utf-8");
const lines = text.split("\n").slice(2); // skip sheet-name line + column-header line

const rows: Row[] = [];
for (const line of lines) {
  if (!line.trim()) continue;
  const parts = line.split("\t");
  const [, jobId, phase, costCode, glAcct, trxDate, desc, jrnl, ref, debit, credit] = parts;
  // The three summary rows at the bottom ALSO carry jobId "1116" (with "Total"
  // stuffed into the Phase column instead) — so filtering on jobId alone still
  // let one of them through and silently doubled the total the first time this
  // ran. Every genuine transaction has a trade date; only the spacer/summary
  // rows don't, so require one.
  if ((jobId ?? "").trim() !== "1116") continue;
  if (!(trxDate ?? "").trim()) continue;
  rows.push({
    jobId: jobId ?? "",
    phase: phase ?? "",
    costCode: costCode ?? "",
    glAcct: glAcct ?? "",
    trxDate: trxDate ?? "",
    desc: desc ?? "",
    jrnl: jrnl ?? "",
    ref: ref ?? "",
    debit: parseNum(debit),
    credit: parseNum(credit),
  });
}

console.log(`Real transaction rows (Job ID = 1116): ${rows.length}`);
const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
console.log(`Sum of real rows -> Debit: ${totalDebit.toFixed(2)}  Credit: ${totalCredit.toFixed(2)}  Net: ${(totalDebit - totalCredit).toFixed(2)}`);
console.log(`(The export's own "1116 Total" / "Report Total" rows state: Debit 406859.38  Credit 57127.28  Net 349732.10 — should match exactly.)`);

// Labor vs everything else.
const laborRows = rows.filter((r) => /hours job/i.test(r.desc));
const laborNet = laborRows.reduce((s, r) => s + r.debit - r.credit, 0);
console.log(`\nLabor rows (desc matches "Hours job"): ${laborRows.length}, net $${laborNet.toFixed(2)}`);
for (const r of laborRows) console.log(`   ${r.trxDate.slice(0, 10)}  ${r.desc}  debit=${r.debit}`);

const nonLaborRows = rows.filter((r) => !/hours job/i.test(r.desc));
const nonLaborNet = nonLaborRows.reduce((s, r) => s + r.debit - r.credit, 0);
console.log(`\nNon-labor ("parts" + freight/tariff/tax) rows: ${nonLaborRows.length}, net $${nonLaborNet.toFixed(2)}`);

// Break the non-labor rows down by rough category (shipping/tariff/tax vs plain parts) —
// just to see how much of the $340K-ish figure is genuine PART cost vs surcharges.
const shipping = nonLaborRows.filter((r) => /shipping/i.test(r.desc));
const tariff = nonLaborRows.filter((r) => /tariff/i.test(r.desc));
const tax = nonLaborRows.filter((r) => /\btax\b/i.test(r.desc));
const freight = nonLaborRows.filter((r) => /freight/i.test(r.desc));
const discount = nonLaborRows.filter((r) => /discount/i.test(r.desc));
const sumNet = (rs: Row[]) => rs.reduce((s, r) => s + r.debit - r.credit, 0);
console.log(`\n  Shipping:  ${shipping.length} rows, net $${sumNet(shipping).toFixed(2)}`);
console.log(`  Tariff:    ${tariff.length} rows, net $${sumNet(tariff).toFixed(2)}`);
console.log(`  Tax:       ${tax.length} rows, net $${sumNet(tax).toFixed(2)}`);
console.log(`  Freight:   ${freight.length} rows, net $${sumNet(freight).toFixed(2)}`);
console.log(`  Discount:  ${discount.length} rows, net $${sumNet(discount).toFixed(2)}`);
const pureParts = nonLaborRows.filter(
  (r) => !/shipping|tariff|\btax\b|freight|discount/i.test(r.desc),
);
console.log(`  Pure parts (everything else): ${pureParts.length} rows, net $${sumNet(pureParts).toFixed(2)}`);

// Distinct Jrnl breakdown among real rows only.
const jrnlCounts = new Map<string, { count: number; net: number }>();
for (const r of rows) {
  const key = r.jrnl || "(blank)";
  const cur = jrnlCounts.get(key) ?? { count: 0, net: 0 };
  cur.count++;
  cur.net += r.debit - r.credit;
  jrnlCounts.set(key, cur);
}
console.log("\n=== By Jrnl (real rows only) ===");
for (const [k, v] of jrnlCounts) console.log(`  ${k}: count=${v.count} net=$${v.net.toFixed(2)}`);

// Exact-duplicate check (same ref+desc+debit+credit appearing more than once) among REAL rows.
const refDescAmt = new Map<string, number>();
for (const r of rows) {
  const key = `${r.ref}|||${r.desc}|||${r.debit}|||${r.credit}`;
  refDescAmt.set(key, (refDescAmt.get(key) ?? 0) + 1);
}
const dupes = [...refDescAmt.entries()].filter(([, c]) => c > 1);
console.log(`\nExact duplicate rows among real transactions: ${dupes.length}`);
for (const [k, c] of dupes) console.log(`  x${c}: ${k}`);

// Distinct PO/Trans Ref count, and rows per ref histogram (spot duplicate-join patterns).
const refCounts = new Map<string, number>();
for (const r of rows) refCounts.set(r.ref, (refCounts.get(r.ref) ?? 0) + 1);
console.log(`\nDistinct Trans Refs: ${refCounts.size}`);
