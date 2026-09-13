import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";

// ── Power BI is not an hours source (2026-08-21) ────────────────────────────
//
// Standing rule: every hour the app reports — actual hours, punches, job hours,
// department/function hours, KPIs, drill-throughs, exports — comes from the
// Paylocity Excel files in the OneDrive folder and from nothing else.
//
// This is enforced as a test rather than trusted to review because the violation is
// so easy to reintroduce accidentally and so hard to SEE once it is in. The old code
// consulted Power BI on the happy path for its code->column resolver, silently fell
// back to a shorter table when the call failed, and bucketed hours differently
// depending on which had happened — with nothing in the output indicating it. A
// grep-shaped test catches the next such import at commit time instead of leaving it
// to be discovered from a wrong total months later.
//
// Scope note: `job-hours-source.ts` still EXISTS and still contains the Power BI
// reader. It is retained deliberately — it holds `hoursByJobSection`, `latestWorkDate`
// and the shared row types, which are pure helpers with no Power BI involvement, and
// the archived reconciliation scripts under scripts/archive/ legitimately query the
// model to compare it against the app. What must not happen is any LIVE module under
// src/ reading hours THROUGH it. That is what this asserts.

const SRC = path.join(process.cwd(), "src");

/** Every .ts/.tsx file under src/, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

// The Power BI hours-reading surface. Named individually rather than matched by a
// loose "powerbi" pattern, because powerbi-client.ts is still legitimately used for
// NON-hours data (the parts/job metadata syncs), and a blanket ban would fail on
// those and then be weakened to nothing.
const FORBIDDEN_HOURS_SYMBOLS = [
  "fetchJobHoursRows",
  "fetchJobHoursRowsWithIssues",
  "buildColumnResolver",
  "readFromPowerBi",
  "configuredSource",
];

// job-hours-source.ts is the Power BI reader itself, so it necessarily names its own
// exports. The boundary is about who IMPORTS them.
const EXEMPT = new Set([path.join(SRC, "lib", "job-hours-source.ts")]);

test("no live module under src/ imports a Power BI hours reader", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (EXEMPT.has(file)) continue;
    // Comments are stripped BEFORE matching imports. Both steps are needed: a
    // comment explaining why a symbol was removed must not fail this test (or the
    // rule becomes undocumentable), and the import pattern below spans newlines, so
    // left in place a comment sitting between two imports gets swallowed into the
    // match — which is exactly the false positive this test produced on first run.
    const text = readFileSync(file, "utf8")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const imports = [...text.matchAll(/import[\s\S]*?from\s+["'][^"']+["']/g)].map((m) => m[0]);
    for (const statement of imports) {
      for (const symbol of FORBIDDEN_HOURS_SYMBOLS) {
        // Word-boundary match so `fetchJobHoursRows` does not also flag
        // `fetchJobHoursRowsWithIssues` twice, and vice versa.
        if (new RegExp(`\\b${symbol}\\b`).test(statement)) {
          offenders.push(`${path.relative(process.cwd(), file)} imports ${symbol}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Power BI must not be an hours source. Read hours through readHoursFeed() (lib/hours-feed.ts) instead:\n  ${offenders.join("\n  ")}`,
  );
});

test("hours-feed exposes exactly one source, and it is the Paylocity Excel files", () => {
  const text = readFileSync(path.join(SRC, "lib", "hours-feed.ts"), "utf8");
  assert.match(text, /export type HoursFeedSource = "paylocity_excel";/, "the feed must declare a single Excel source");
  assert.ok(!/HOURS_SOURCE/.test(text.replace(/\/\/.*$/gm, "")), "the HOURS_SOURCE=power_bi escape hatch must stay removed");
});

test("no live module reads a hours-bearing environment escape hatch", () => {
  // HOURS_SOURCE was the switch that let Power BI serve hours. Its absence is part of
  // the guarantee, so its reintroduction anywhere under src/ fails here.
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (/HOURS_SOURCE/.test(text)) offenders.push(path.relative(process.cwd(), file));
  }
  assert.deepEqual(offenders, [], `HOURS_SOURCE must not be read anywhere: ${offenders.join(", ")}`);
});
