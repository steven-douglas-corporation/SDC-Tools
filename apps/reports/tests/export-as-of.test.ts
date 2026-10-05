import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AS_OF_MIN, asOfWindow, isMonthEnd, parseAsOf } from "../src/lib/export/as-of";

// ── "Values as of" for the Projects export (2026-10-05) ─────────────────────────────
//
// An export-only date: hours by punch date, Parts Cost actuals by AP invoice date, through
// that day. Blank (the default) is the live export, unchanged. The date rules are pure and
// tested with fixtures; the queries and the wiring are pinned by source shape (the
// convention for Total ETO code, whose SQL needs a live connection) and were also checked
// against live data when this was written.

const TODAY = "2026-10-05";

// ── parseAsOf ────────────────────────────────────────────────────────────────

test("blank, whitespace and absent all mean LIVE (the default)", () => {
  for (const raw of [undefined, null, "", "   "]) assert.deepEqual(parseAsOf(raw, TODAY), { ok: true, asOf: null });
});

test("a real date between the floor and today is accepted, trimmed", () => {
  assert.deepEqual(parseAsOf("2026-09-30", TODAY), { ok: true, asOf: "2026-09-30" });
  assert.deepEqual(parseAsOf(" 2026-09-30 ", TODAY), { ok: true, asOf: "2026-09-30" });
  assert.deepEqual(parseAsOf(TODAY, TODAY), { ok: true, asOf: TODAY }, "today itself is allowed");
  assert.deepEqual(parseAsOf(AS_OF_MIN, TODAY), { ok: true, asOf: AS_OF_MIN }, "the floor itself is allowed");
});

test("a date in the future is refused, with a reason that says what to do", () => {
  const r = parseAsOf("2026-10-06", TODAY);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /future/);
  assert.match((r as { error: string }).error, /blank/i);
});

test("a date before the migration snapshot's end is refused — it cannot be cut at a day", () => {
  const r = parseAsOf("2025-01-30", TODAY);
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, new RegExp(AS_OF_MIN));
});

test("anything that is not a real calendar date is refused, including look-alikes", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-9-30", "09/30/2026", "20260930", "2026-09-30T00:00:00Z", "'; DROP TABLE x;--", "2026-00-10"]) {
    assert.equal(parseAsOf(bad, TODAY).ok, false, JSON.stringify(bad));
  }
  assert.equal(parseAsOf("2028-02-29", "2030-01-01").ok, true, "a real leap day is fine");
  assert.equal(parseAsOf("2027-02-29", "2030-01-01").ok, false, "a fake one is not");
});

// ── isMonthEnd / asOfWindow ──────────────────────────────────────────────────

test("isMonthEnd is calendar-correct, leap years included", () => {
  assert.equal(isMonthEnd("2026-09-30"), true);
  assert.equal(isMonthEnd("2026-09-29"), false);
  assert.equal(isMonthEnd("2026-10-31"), true);
  assert.equal(isMonthEnd("2026-02-28"), true);
  assert.equal(isMonthEnd("2028-02-28"), false);
  assert.equal(isMonthEnd("2028-02-29"), true);
  assert.equal(isMonthEnd("2026-12-31"), true);
});

test("a month-end cutoff counts that month's frozen figure; a mid-month cutoff stops at the month before", () => {
  // A frozen ETC month is ONE number for the whole month, so it can only count once the
  // month has fully ended by the cutoff.
  assert.equal(asOfWindow("2026-09-30").frozenMonthCap, "2026-09");
  assert.equal(asOfWindow("2026-09-15").frozenMonthCap, "2026-08");
  assert.equal(asOfWindow("2026-01-15").frozenMonthCap, "2025-12", "across a year boundary");
  assert.equal(asOfWindow("2026-03-01").frozenMonthCap, "2026-02");
});

test("the punch cutoff is UTC midnight of the day itself, so the whole day is included by <=", () => {
  assert.equal(asOfWindow("2026-09-30").punchThrough.toISOString(), "2026-09-30T00:00:00.000Z");
});

// ── The live export is untouched ─────────────────────────────────────────────

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, "");

test("a blank date produces the original headers byte for byte", () => {
  const src = read("src", "lib", "export", "projects-export.ts");
  // `through` is "" with no date, so every header collapses to its pre-date spelling.
  assert.match(src, /const through = asOf \? `, through \$\{asOf\}` : "";/);
  assert.match(src, /header: `Parts Cost Actual \(GL-posted\$\{through\}\)`/);
  assert.match(src, /header: `Actual Hours \(total\$\{through\}\)`/);
  assert.match(src, /header: `SDC Billed \(GL-posted, \$\{asOf \? `through \$\{asOf\}` : "lifetime"\}\)`/);
  // The default is null, not "today": nothing is date-cut unless a date was asked for.
  assert.match(src, /asOf: string \| null = null,/);
});

test("without a date the Parts Cost Actual column is still the stored value, exactly as before", () => {
  const src = strip(read("src", "lib", "export", "projects-export.ts"));
  assert.match(src, /const costActualShown = asOf !== null && split \? round2\(split\.actual\) : costActual;/);
});

test("the hours loader's queries are unchanged when no date is given", () => {
  const src = strip(read("src", "lib", "actual-hours.ts"));
  const fn = src.slice(src.indexOf("export async function loadActualHoursBySection"), src.indexOf("export async function loadMonthlyWorkedBySection"));
  // Both extra conditions are spread in ONLY when a cutoff exists.
  assert.match(fn, /month: \{ notIn: covered, \.\.\.\(cut \? \{ lte: cut\.frozenMonthCap \} : \{\}\) \}/);
  assert.match(fn, /\.\.\.\(cut \? \{ workDate: \{ lte: cut\.punchThrough \} \} : \{\}\)/);
  assert.match(fn, /const cut = asOf !== undefined \? asOfWindow\(asOf\) : null;/);
  // And the signature keeps the date optional, so every other caller compiles unchanged.
  assert.match(fn, /loadActualHoursBySection\(jobPks: number\[\], asOf\?: string\)/);
});

// ── The grid cannot be affected ──────────────────────────────────────────────

test("no page, grid query or sync ever passes a date to the hours loader or the SDC split", () => {
  for (const rel of [
    ["src", "app", "(app)", "quoted", "page.tsx"],
    ["src", "lib", "projects-query.ts"],
    ["src", "lib", "job-hours-dashboard.ts"],
    ["src", "app", "api", "integration", "jobs", "[jobId]", "hours", "route.ts"],
  ]) {
    let text = "";
    try { text = read(...rel); } catch { continue; }
    assert.doesNotMatch(strip(text), /loadActualHoursBySection\([^)]*,\s*[^)]*\)/, `${rel.join("/")} must call the hours loader with no date`);
    assert.doesNotMatch(text, /getPartsActualSdcSplitByJob|parseAsOf/, `${rel.join("/")} must not use the export date`);
  }
});

test("the Projects page only turns the picker on; the grid still reads its own URL, not asOf", () => {
  const page = read("src", "app", "(app)", "quoted", "page.tsx");
  assert.match(page, /<ExportMenu report="projects" asOf className=\{BUTTON_SECONDARY\} \/>/);
  assert.doesNotMatch(page, /sp\.asOf|searchParams[^;\n]*asOf/, "the grid must not read an asOf param");
});

// ── The Export menu ──────────────────────────────────────────────────────────

test("the picker is blank by default, clears when the menu closes, and never touches the page URL", () => {
  const src = read("src", "components", "ExportMenu.tsx");
  assert.match(src, /const \[asOfValue, setAsOfValue\] = useState\(""\);/, "blank by default");
  assert.match(src, /useEffect\(\(\) => \{\s*if \(!open\) setAsOfValue\(""\);\s*\}, \[open\]\);/, "cleared on close");
  // Built from the picker only: a stray ?asOf= in the address bar is dropped first.
  assert.match(src, /qs\.delete\("asOf"\);\s*if \(offerAsOf && asOfValue\) qs\.set\("asOf", asOfValue\);/);
  // Never navigates or writes the URL.
  assert.doesNotMatch(src, /router\.(push|replace)|history\.(push|replace)State|window\.location\s*=/);
  // A bad date greys out BOTH formats.
  assert.equal((src.match(/asOfProblem !== null/g) ?? []).length, 2);
});

test("only the Projects page offers the picker", () => {
  for (const rel of [["src", "app", "(app)", "hours", "page.tsx"], ["src", "app", "(app)", "etc", "page.tsx"]]) {
    assert.doesNotMatch(read(...rel), /<ExportMenu[^>]*\basOf\b/, `${rel.join("/")} must not offer a date`);
  }
});

// ── The route ────────────────────────────────────────────────────────────────

test("the route validates the date before any query runs, and only for Projects", () => {
  const src = read("src", "app", "api", "export", "[report]", "route.ts");
  assert.match(src, /import \{ parseAsOf \} from "@\/lib\/export\/as-of";/);
  assert.match(
    src,
    /if \(report === "projects"\) \{\s*const parsed = parseAsOf\(searchParams\.get\("asOf"\), todayStamp\(now\)\);\s*if \(!parsed\.ok\) return new Response\(parsed\.error, \{ status: 400/,
  );
  // Validated BEFORE the try that runs the builders.
  assert.ok(src.indexOf("parseAsOf(searchParams") < src.indexOf("await buildProjectsExport("), "validation precedes the build");
  assert.match(src, /buildProjectsExport\([\s\S]*?now,\s*asOf,\s*\)/, "the validated date, not the raw string, reaches the builder");
  // Named in the file and in the audit record.
  assert.match(src, /asOf \? `AsOf\$\{asOf\}` : null/);
  assert.match(src, /\(values as of \$\{asOf\}\)/);
  assert.match(src, /\n\s*asOf,\n/, "asOf is its own field in the audit metadata");
});

// ── The SQL ──────────────────────────────────────────────────────────────────

test("the date is a bound parameter, never part of the SQL text", () => {
  const src = strip(read("src", "lib", "sync-totaleto.ts"));
  const fn = src.slice(src.indexOf("export async function getPartsActualSdcSplitByJob"));
  const body = fn.slice(0, fn.indexOf('feed: "parts_actual.sdc_split_by_job"'));
  assert.match(body, /\.input\("asOf", sql\.VarChar\(10\), asOf\)/);
  assert.match(body, /@asOf IS NULL OR APBD\.APDocDate < DATEADD\(day, 1, CONVERT\(date, @asOf, 23\)\)/);
  // Only the SQL text itself (the guard's own error message above it legitimately names asOf).
  const sqlText = body.slice(body.indexOf(".query("));
  assert.doesNotMatch(sqlText, /\$\{asOf\}/, "asOf must never be interpolated into the query text");
  // The cut sits inside the SUM so a job with only later invoices still comes back, as $0.
  assert.match(body, /SUM\(CASE WHEN @asOf IS NULL OR[\s\S]*?THEN \$\{AP_LINE_AMOUNT\} ELSE 0 END\) AS Amount/);
  assert.match(body, /\$\{glPostedAp\("SFC"\)\}/, "still the shared GL-posted predicate");
  // Defence in depth on top of the route's own validation.
  assert.match(fn, /if \(asOf !== null && !\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test\(asOf\)\) throw new Error/);
});

test("with a date, a missing Total ETO answer is an error, never today's stored total under a past heading", () => {
  const src = read("src", "lib", "export", "projects-export.ts");
  assert.match(src, /if \(asOf\) \{\s*throw new Error\(\s*`Total ETO did not respond, so Parts Cost as of \$\{asOf\} cannot be calculated/);
  assert.match(src, /let sdcSplit: Map<string, PartsActualSdcSplit> \| null = null;\s*try \{\s*sdcSplit = await getPartsActualSdcSplitByJob\(asOf\);/);
});
