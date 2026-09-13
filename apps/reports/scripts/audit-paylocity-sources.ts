// Audit of the Paylocity source-selection rule: which workbook owns which punch
// year, what each file actually contains, and how much duplicate ingestion the
// year rule prevents. Run with:
//
//   npx tsx -r ./scripts/shim-server-only.cjs scripts/audit-paylocity-sources.ts
//
// Answers, in order, the questions the 2026-08-21 request asked:
//   - rows loaded from each workbook
//   - minimum and maximum punch date in each file
//   - rows excluded because they belong to another file's authoritative year
//   - duplicate/overlapping punches detected
//   - duplicate hours prevented
//
// Reads through the real feed (hours-feed.ts -> paylocity-sources.ts), not a
// re-implementation, so what it reports is what the app actually ingests. The
// cross-file overlap section reads the raw files directly as well, because
// measuring the overlap requires seeing the rows the feed has already correctly
// discarded.
import { readFileSync } from "fs";
import * as XLSX from "xlsx";
import { readHoursFeed } from "../src/lib/hours-feed";
import { allSources, punchSources, yearsWithoutPunchSource } from "../src/lib/paylocity-sources";

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const pad = (n: number, w = 12) => f2(n).padStart(w);
const normJob = (v: unknown) => String(v ?? "").trim().replace(/^0+/, "");

type RawRow = { emp: string; date: string; job: string; sec: string; fn: string; hours: number };

/** Every punch row in a workbook, unfiltered — the basis for measuring overlap. */
function readRawPunches(file: string): RawRow[] {
  const wb = XLSX.read(readFileSync(file), { cellDates: true });
  const sheet = wb.Sheets["Report"];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: true, defval: null }).map((r) => {
    const d = r["Work Date"];
    return {
      emp: String(r["Employee Id"] ?? ""),
      date: d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? "").slice(0, 10),
      job: normJob(r["Jobs"]),
      sec: String(r["MachineSec"] ?? "").trim(),
      fn: String(r["Function"] ?? "").trim(),
      hours: Number(r["Total Hours Worked"]) || 0,
    };
  });
}

/**
 * The strongest punch identity the export actually supports: employee, work date,
 * job, section and function. NOT including hours, deliberately — two files holding
 * the same punch with a corrected duration are still the same punch, and keying on
 * hours would hide exactly that case.
 */
const punchKey = (r: RawRow) => `${r.emp}|${r.date}|${r.job}|${r.sec}|${r.fn}`;

async function main() {
  console.log("=".repeat(84));
  console.log("PAYLOCITY SOURCE-SELECTION AUDIT");
  console.log("=".repeat(84));

  // ── The declared rule ────────────────────────────────────────────────────
  console.log("\n--- DECLARED YEAR OWNERSHIP (paylocity-sources.ts) ---");
  for (const s of allSources()) {
    console.log(`  ${s.fileName.padEnd(30)} owns ${s.ownershipLabel.padEnd(18)} [${s.kind}]`);
    console.log(`  ${" ".repeat(30)} ${s.note}`);
  }
  const gaps = yearsWithoutPunchSource();
  if (gaps.length) {
    console.log(`\n  NOT INGESTIBLE AS PUNCHES:`);
    for (const g of gaps) {
      console.log(`   ${g.fileName} (owns ${g.ownershipLabel}) — ${g.kind}`);
      console.log(`     punches in ${g.ownershipLabel} therefore have NO punch-grain source.`);
    }
  }

  // ── What each file actually holds ────────────────────────────────────────
  console.log("\n--- RAW FILE CONTENTS (unfiltered, straight from disk) ---");
  const raw = new Map<string, RawRow[]>();
  for (const s of punchSources()) {
    const rows = readRawPunches(s.path);
    raw.set(s.fileName, rows);
    const dated = rows.filter((r) => r.date);
    const dates = dated.map((r) => r.date).sort();
    console.log(
      `  ${s.fileName.padEnd(30)} ${String(rows.length).padStart(6)} rows  ${pad(rows.reduce((a, r) => a + r.hours, 0))}h  ` +
        `${dates[0] ?? "—"} -> ${dates[dates.length - 1] ?? "—"}`,
    );
    const byYear = new Map<string, { n: number; h: number }>();
    for (const r of dated) {
      const y = r.date.slice(0, 4);
      const v = byYear.get(y) ?? { n: 0, h: 0 };
      v.n += 1;
      v.h += r.hours;
      byYear.set(y, v);
    }
    for (const y of [...byYear.keys()].sort()) {
      const v = byYear.get(y)!;
      const owned = s.ownsYear(Number(y));
      console.log(
        `    ${y}: ${String(v.n).padStart(6)} rows ${pad(v.h)}h  ${owned ? "OWNED — ingested" : "NOT OWNED — excluded, another file is authoritative"}`,
      );
    }
  }

  // ── Cross-file overlap: what the year rule is protecting against ─────────
  console.log("\n--- CROSS-FILE OVERLAP (same employee|date|job|section|function) ---");
  const files = [...raw.keys()];
  let preventedTotal = 0;
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const a = raw.get(files[i])!;
      const b = raw.get(files[j])!;
      const aKeys = new Set(a.map(punchKey));
      const shared = b.filter((r) => aKeys.has(punchKey(r)));
      const sharedHours = shared.reduce((s, r) => s + r.hours, 0);
      console.log(`  ${files[i]} <-> ${files[j]}`);
      console.log(`    overlapping punches : ${shared.length} rows, ${f2(sharedHours)}h`);
      if (shared.length) {
        const byMonth = new Map<string, number>();
        for (const r of shared) byMonth.set(r.date.slice(0, 7), (byMonth.get(r.date.slice(0, 7)) ?? 0) + r.hours);
        console.log(
          `    by month            : ${[...byMonth].sort().map(([m, h]) => `${m} ${f2(h)}h`).join(", ")}`,
        );
        console.log(`    ^ would be DOUBLE-COUNTED if the files were concatenated. The year rule prevents this.`);
        preventedTotal += sharedHours;
      }
    }
  }
  console.log(`\n  duplicate hours prevented by the year rule: ${f2(preventedTotal)}h`);

  // ── What the feed actually did ───────────────────────────────────────────
  console.log("\n--- THE FEED, AS THE APP READS IT ---");
  const feed = await readHoursFeed();
  console.log(`  note: ${feed.provenance.note}`);
  console.log(`\n  ${"file".padEnd(30)} ${"owns".padEnd(18)} ${"read".padStart(7)} ${"ingested".padStart(9)} ${"excluded".padStart(9)} ${"excl. hours".padStart(12)}`);
  let ingested = 0;
  let excludedRows = 0;
  let excludedHours = 0;
  for (const s of feed.provenance.sources ?? []) {
    console.log(
      `  ${s.fileName.padEnd(30)} ${s.ownershipLabel.padEnd(18)} ${String(s.rowsRead).padStart(7)} ` +
        `${String(s.rowsResolved).padStart(9)} ${String(s.rowsExcludedByYear).padStart(9)} ${pad(s.hoursExcludedByYear)}`,
    );
    if (s.rowsExcludedByYear > 0) {
      console.log(`  ${" ".repeat(30)} excluded years: ${s.excludedYears.join(", ")} (owned by another file)`);
    }
    console.log(
      `  ${" ".repeat(30)} file date span: ${s.firstWorkDate?.toISOString().slice(0, 10) ?? "—"} -> ${s.lastWorkDate?.toISOString().slice(0, 10) ?? "—"}`,
    );
    ingested += s.rowsResolved;
    excludedRows += s.rowsExcludedByYear;
    excludedHours += s.hoursExcludedByYear;
  }
  console.log(`\n  total ingested rows          : ${ingested}`);
  console.log(`  total excluded by year rule  : ${excludedRows} rows / ${f2(excludedHours)}h`);
  console.log(`  feed rows delivered          : ${feed.rows.length}`);
  console.log(`  feed hours delivered         : ${f2(feed.rows.reduce((s, r) => s + r.hours, 0))}`);

  // ── The invariant: no punch year is served by two files ─────────────────
  console.log("\n--- CHECK: each punch year has exactly one source in the delivered feed ---");
  const yearFiles = new Map<number, Set<string>>();
  for (const s of feed.provenance.sources ?? []) {
    // Reconstruct which years this file contributed by intersecting what it owns
    // with what it holds — the feed rows themselves carry no file provenance.
    for (const r of raw.get(s.fileName) ?? []) {
      if (!r.date) continue;
      const y = Number(r.date.slice(0, 4));
      const src = punchSources().find((p) => p.fileName === s.fileName)!;
      if (!src.ownsYear(y)) continue;
      const set = yearFiles.get(y) ?? new Set();
      set.add(s.fileName);
      yearFiles.set(y, set);
    }
  }
  let failed = false;
  for (const y of [...yearFiles.keys()].sort()) {
    const set = yearFiles.get(y)!;
    const ok = set.size === 1;
    if (!ok) failed = true;
    console.log(`  ${ok ? "OK  " : "FAIL"}  ${y}: ${[...set].join(", ")}`);
  }

  console.log("");
  if (failed) {
    console.error("AUDIT FAILED — a punch year is served by more than one file.");
    process.exitCode = 1;
  } else {
    console.log("Every ingested punch year has exactly one authoritative source.");
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
