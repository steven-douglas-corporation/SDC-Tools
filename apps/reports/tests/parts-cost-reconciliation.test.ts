import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Parts-cost reconciliation (2026-09-02 data-integrity audit) ─────────────
//
// The report that started this: for job 1101 the Parts List footer read Invoiced
// $290,266 while the Parts Cost card read $730,483 — same job, same word, a
// $440,217 difference and nothing on screen to say which was right.
//
// Two real defects and one legitimate scope difference, all measured against live
// Total ETO data (2,132 PO lines, 579 distinct part numbers):
//
//   1. The BOM table read only each part's NEWEST PO line, so 1,553 lines — 73% of
//      the job — were represented nowhere. Fixed: the money columns sum every line.
//   2. It summed `invoicedAmount` (billed, $749,981) where the card sums
//      `actualAmount` (GL-posted, $730,483). Fixed: both now use the GL-posted
//      basis, the app's one definition of Parts Actual.
//   3. What legitimately remains is scope — PO lines for part numbers no BOM row
//      carries. Measured after the fix: $702,967 on BOM rows + $88,643 unmatched =
//      $791,609, the card's lifetime figure exactly. Now stated in the footer.
//
// These are source-level guards: there is no DOM in this suite, and the arithmetic
// above was verified in the running app rather than simulated here.

const SRC = join(import.meta.dirname, "..", "src");
const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const PO_DETAIL = strip(readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8"));
const PROC = strip(readFileSync(join(SRC, "components", "JobProcurement.tsx"), "utf8"));
const FIN = strip(readFileSync(join(SRC, "lib", "parts-cost-financials.ts"), "utf8"));

test("a BOM row's cost is every PO line the part has, not just the newest", () => {
  // `?.[0]` is the newest line and is still used for DISPLAY fields (PO #, supplier,
  // dates) — those describe a purchase, not the part. It must not be what the money
  // columns are computed from.
  assert.match(PO_DETAIL, /const totalPrice = pnLines \? splitSum\(\(l\) => l\.totalPrice\)/);
  assert.match(PO_DETAIL, /\? splitSum\(\(l\) => l\.actualAmount\)/);
  assert.ok(!/const totalPrice = line\?\.totalPrice/.test(PO_DETAIL), "newest-line-only cost must not return");
  assert.ok(!/invoicedAmount = activeAttribution \? \(windowedInvoiced \?\? 0\) : \(line\?\.invoicedAmount \?\? 0\)/.test(PO_DETAIL));
});

test("the table and the card measure invoiced on the same basis", () => {
  // The whole class of bug: two views of one job summing different fields under one
  // word. `actualAmount` is the GL-posted slice and the app's one definition of
  // Parts Actual; `invoicedAmount` includes documents flagged never-to-export and is
  // $19,498 higher on job 1101.
  assert.match(FIN, /const invoiced = actualTotal\(lines\)/);
  assert.match(PO_DETAIL, /l\.actualAmount/, "the BOM table must sum the same field");
});

test("a part number on two BOM rows is split, never counted twice", () => {
  // Summing a part's whole history onto its row is right when the part has one row;
  // with two it would trade an under-count for an over-count. Measured on 1101: 529
  // BOM rows, 528 distinct part numbers — the divisor is 1 for all but one part, so
  // it exists for correctness rather than because it is load-bearing.
  assert.match(PO_DETAIL, /const shareOf = \(pn: string\) => shareCount\.get\(normPn\(pn\)\) \|\| 1;/);
  assert.match(PO_DETAIL, /\/ shareOf\(p\.pn\)/);
  // Applied to the windowed figure too — attributeInvoicedWindow already sums across
  // every line, so it needs the same division and no other change.
  assert.match(PO_DETAIL, /\(windowedInvoiced \?\? 0\) \/ shareOf\(p\.pn\)/);
});

test("the share pre-pass counts each BOM part once, over the same tree the rows come from", () => {
  // Counted by part id, like `seen` in enrich — a part reached twice through the
  // tree is one row and must be one share, or the divisor would shrink its money.
  assert.match(PO_DETAIL, /if \(counted\.has\(part\.id\)\) return;/);
  assert.match(PO_DETAIL, /for \(const section of bom\.roots\)/);
});

test("nothing is reported only as a footer summary — the rows exist", () => {
  // This started as a sentence standing in for 471 purchase lines. The footer now
  // states arithmetic over rows that are actually in the table, and the non-BOM half
  // is a button into them.
  assert.match(PROC, /onClick=\{\(\) => setScope\("nonbom"\)\}/, "the summary must be clickable");
  assert.match(PROC, /are not BOM parts/);
  assert.ok(!/more sits on .* part number/.test(PROC), "the old un-clickable summary must not return");
});

test("the footer proves it adds up, and says so when it does not", () => {
  // `unexplained` should be zero now that every purchase line becomes a row. It is
  // computed and rendered each time rather than assumed, so a future change that
  // drops rows shows up on screen instead of silently shrinking a total.
  // Estimates come out first: a BOM part with no purchase line is priced from the
  // BOM (unit x qty), so leaving it in would compare an estimate against actual PO
  // spend. Measured on 1101: $3,630, which is exactly what the guard caught when it
  // first went in.
  assert.match(PROC, /unexplained: jobTotal - \(matchedTotal - estimated\)/);
  assert.match(PROC, /p\.matchReason === "no-purchase"/);
  assert.match(PROC, /Math\.abs\(reconcile\.unexplained\) > 0\.5/);
  // Wording changed 2026-09-03 (the footer rewrite) — "Mismatch — $X unaccounted,
  // report this" replaces "$X unaccounted — report this". Still the same guard:
  // whatever the phrasing, a footer that cannot prove the sum must say so on screen.
  assert.match(PROC, /unaccounted, report this/);
  // The status is a word, not left for the reader to infer from two numbers.
  assert.match(PROC, /Fully reconciled/);
  assert.match(PROC, /Partially reconciled/);
});

test("the footer states both halves of the equation, and both add up to the job total", () => {
  // The old strip named only the non-BOM half and the job total, leaving "so what is
  // the BOM, then" as arithmetic for the reader. Both addends are stated now.
  //
  // `bomPurchased` must exclude `estimated` for the same reason `unexplained` does:
  // a BOM part with nothing bought is priced unit x qty from the BOM, so including it
  // would print BOM + non-BOM = a number LARGER than the job total, by exactly that
  // amount. An equation on screen that visibly does not balance is worse than no
  // equation, which is the whole point of this rewrite.
  assert.match(PROC, /bomPurchased: parts\.reduce\(\(sum, p\) => sum \+ p\.totalPrice, 0\) - nonBomTotal - estimated/);
  assert.match(PROC, /usd\(reconcile\.bomPurchased\)/);
  assert.match(PROC, /usd\(reconcile\.nonBomTotal\)/);
  assert.match(PROC, /usd\(reconcile\.jobTotal\)/);
});

test("the footer never mixes the visible-row scope with the job scope", () => {
  // The reported confusion: one sentence counted the rows left after every filter
  // ("56 rows shown") and then quoted a job-lifetime total ("Job lifetime $36,931"),
  // two different scopes with nothing marking the seam. They are two labelled lines
  // now, and the money line says "Whole job" whenever the row line is narrowed.
  assert.match(PROC, /narrowed: parts\.length < reconcile\.allRows/);
  assert.match(PROC, /visible\.narrowed \? "Whole job" : "Totals"/);
  // Row counts come off the RENDERED rows, so the count always matches what scrolls.
  assert.match(PROC, /for \(const p of parts\) if \(!p\.nonBom\) bomRows\+\+;/);
  // The awkward phrasing the request named, gone from the rendered output. Each is
  // still allowed to appear in a comment explaining why it went.
  const rendered = PROC.slice(PROC.indexOf('<tr className="bg-sdc-navy text-label text-white/70">'));
  assert.ok(!/every PO line each part has/.test(rendered), "the run-on sentence must not return");
  assert.ok(!/fully accounted for by the rows above/.test(rendered));
});

test("the residual describes the job, not the current filter", () => {
  // Computed over the unfiltered `parts` and every line: a supplier filter must not
  // change what "no BOM row" means.
  const block = PROC.slice(PROC.indexOf("const reconcile = useMemo("), PROC.indexOf("}, [parts, partsLines]);"));
  assert.match(block, /for \(const p of parts\)/, "unfiltered parts");
  assert.ok(!/filtered/.test(block), "must not read the filtered row set");
  assert.match(PROC, /\}, \[parts, partsLines\]\)/);
});

test("the residual is measured on the GL-posted basis, like both totals it bridges", () => {
  const block = PROC.slice(PROC.indexOf("const reconcile = useMemo("), PROC.indexOf("}, [parts, partsLines])"));
  assert.match(block, /jobInvoiced \+= l\.actualAmount/);
  assert.ok(!/l\.invoicedAmount/.test(block), "the bridge must not mix a billed figure into a GL-posted one");
});


test("a non-BOM charge is not judged by a BOM delivery status", () => {
  // Every status is a delivery state (received, due soon, late, uncovered). A
  // freight line has none, so it could only ever fail the filter — which is how 99
  // synthesized rows were counted by the scope chip and then filtered off screen.
  assert.match(PROC, /if \(!p\.nonBom && status\.size < ALL_STATUS_KEYS\.length\)/);
});

test("a BOM part with no purchase line reads as unbought, not as non-BOM", () => {
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.match(PO, /!pnLines \? "no-purchase" : \(recovered \?\? "matched"\)/);
});

test("the corrected join only ever recovers a spelling of a part the BOM already has", () => {
  // Every alternate is a deterministic transform of a BOM part's own number, looked
  // up against numbers that exist. Nothing fuzzy: two genuinely different parts can
  // never be merged by this.
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.match(PO, /for \(const alt of alternateKeys\(p\.pn\)\)/);
  assert.match(PO, /altLookup\.get\(alt\.key\)/);
  // Alternates are collected ALONGSIDE the exact key, not only when it misses.
  // Job 1101 has a BOM part with lines under both `MASTN20_325` and `MASTN20-325`:
  // the exact key hit, recovery never ran, and the hyphen lines stayed orphaned.
  assert.match(PO, /const exactLines = \(lineIndex\.get\(normPn\(p\.pn\)\)/);
  assert.match(PO, /const pnLines = collected\.length > 0 \? collected : null;/);
  // A BOM part's exact key never enters the recovery index (2026-09-14). The
  // earlier "first writer wins" rule registered exact keys too, so whether the
  // hyphen lines above were recovered depended on which spelling SQL returned
  // first — tests/parts-list-po-drawer.test.ts runs both orders. Excluding BOM
  // keys is what makes "only a spelling of a part the BOM already has" hold
  // regardless of order: the index holds ONLY non-BOM spellings, looked up by a
  // BOM part's own transforms.
  assert.match(PO, /if \(shareCount\.has\(key\)\) continue;/, "a BOM part's exact key is not a recovery candidate");
  assert.doesNotMatch(PO, /if \(!altLookup\.has\(alt\.key\)\) altLookup\.set/, "first-writer-wins is gone — it made recovery depend on SQL row order");
});

test("matched and non-BOM rows are disjoint by construction", () => {
  // The invariant: a purchase line consumed by a BOM row — including one the
  // corrected join recovered — can never also appear as a non-BOM row.
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.match(PO, /if \(pnLines\) for \(const l of pnLines\) usedLines\.add\(l\);/);
  assert.match(PO, /if \(usedLines\.has\(l\)\) continue;/);
});

test("join failures are classified before any keyword", () => {
  // A line a corrected join would attach to a BOM part is a defect to fix, not a
  // category to file it under — classifying it as "freight" because its description
  // mentions shipping would bury the thing worth finding.
  const REASON = readFileSync(join(SRC, "lib", "parts-match-reason.ts"), "utf8");
  const fn = REASON.slice(REASON.indexOf("export function classifyUnmatched"));
  assert.ok(fn.indexOf("if (recovered) return recovered;") < fn.indexOf("for (const rule of RULES)"));
});

test("credits keep their sign", () => {
  const REASON = readFileSync(join(SRC, "lib", "parts-match-reason.ts"), "utf8");
  assert.match(REASON, /if \(amount < 0\) return "credit";/);
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.ok(!/Math\.max\(0,[^)]*totalPrice/.test(PO), "no clamping of a negative line");
});

// ── The two claim rules, and why they differ (2026-09-02) ───────────────────
//
// Verified across 35 active jobs: every one reconciles to the cent, on both the
// purchased and the GL-posted total. Getting there took two corrections that only
// showed up at that scale — 9 of the first 11 jobs passed, and the two that did not
// were failing for a reason no single-job check would have surfaced.

test("an exact-key claim is unconditional, so two rows sharing a part number both get a share", () => {
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  // Skipping an already-claimed line here left the second row with nothing while
  // the first still divided its money in two — half the part's cost vanishing.
  assert.match(PO, /const exactLines = \(lineIndex\.get\(normPn\(p\.pn\)\) \?\? \[\]\)\.filter\(\(l\) => !altClaimed\.has\(l\)\)/);
  assert.match(PO, /sumLines\(exactLines, f\) \/ shareOf\(p\.pn\) \+ sumLines\(altLines, f\)/);
});

test("a recovered line is not divided by a share — exactly one row owns it", () => {
  // `shareOf` is about rows entitled to the SAME exact key. A differently-spelled
  // line is claimed once, so dividing it sends the remainder nowhere.
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.match(PO, /Exact lines take a share; recovered lines belong wholly to this row/);
});

test("an exact key cannot re-take a line an earlier part already recovered", () => {
  // The $8 on job 1104 and the $169 on 1125: a part whose alternate spelling was
  // recovered BEFORE the part holding the exact key was reached, so the same line
  // was counted twice. `altClaimed` is what makes the unconditional exact claim safe.
  const PO = readFileSync(join(SRC, "lib", "po-detail.ts"), "utf8");
  assert.match(PO, /const altClaimed = new Set<PartsCostLine>\(\);/);
  assert.match(PO, /altClaimed\.add\(l\);/);
});

// ── One round trip per selection, not one per job (2026-09-02) ─────────────
//
// Both the Parts Cost card and T&M fanned out at 6 concurrent Total ETO calls.
// Measured on the same work: 5,766ms across 239 jobs became 571ms; the card's own
// 40-job selection now resolves in 496ms. The 35-job reconciliation above was
// re-run against the new path and is unchanged — same lines, same totals.

test("the Parts Cost card reads the whole selection in one query", () => {
  const FIN = readFileSync(join(SRC, "lib", "parts-cost-financials.ts"), "utf8");
  assert.match(FIN, /getPartsCostForJobs\(jobs\.map\(\(j\) => j\.jobId\)\)/);
  assert.ok(!/mapWithConcurrency/.test(FIN), "the per-job fan-out is gone");
  assert.ok(!/getJobPartsCost\(/.test(FIN), "and so is the per-job call");
});

test("a failed batch read reports every job failed, never a confident zero", () => {
  // Per job this was partial — one job times out, `failedJobs` counts it. One query
  // is all-or-nothing, and an empty set with failedJobs 0 would render $0 as though
  // it were an answer, on a card people read as a budget position.
  const FIN = readFileSync(join(SRC, "lib", "parts-cost-financials.ts"), "utf8");
  assert.match(FIN, /const failedJobs = byJob \? 0 : jobs\.length;/);
  assert.match(FIN, /const lines: PartsCostLine\[\] = byJob \? jobs\.flatMap\(\(j\) => byJob\.get\(j\.jobId\) \?\? \[\]\) : \[\];/);
});

// ── The window draws less, counts the same (2026-09-04) ─────────────────────
//
// The Parts List is one continuous scroll over every filtered row, with only the rows
// near the viewport in the DOM. It paged at 50 for one day (2026-09-03) and was
// replaced by request: "I do not want page-by-page navigation."
//
// The hazard is unchanged and is the one this file's footer exists to prevent: a total
// that quietly covers only what is on screen while the strip above it says 628. It is
// now WORSE if got wrong, because the visible set moves as you scroll — a footer
// summing it would change while the user did nothing but drag a scrollbar.
//
// Asserted against PROC, which has comments stripped — so every match below is on real
// code, not on a comment describing it.

test("the rendered window is a slice; the totals still cover every filtered row", () => {
  // Sorted first, then windowed — otherwise the visible rows are an arbitrary 60 of
  // the set re-sorted among themselves rather than a piece of the real order.
  // Display rows since 2026-09-13: parts interleaved with any expanded PO sub-rows,
  // all ROW_H tall — see tests/parts-list-expand-rows.test.ts.
  assert.match(PROC, /const visibleRows = displayRows\.slice\(win\.start, win\.end\)/);
  assert.match(PROC, /\{visibleRows\.map\(\(row, i\) => \{/, "the tbody renders the window");

  // The column totals and the row counts must still reduce over `parts` — the whole
  // filtered set — never over what happens to be on screen.
  assert.match(PROC, /const tot = parts\.reduce\(/, "column totals stay over every filtered row");
  assert.match(
    PROC,
    /for \(const p of parts\) if \(!p\.nonBom\) bomRows\+\+;/,
    "row counts stay over every filtered row",
  );
  assert.ok(
    !/visibleRows\.reduce\(/.test(PROC) && !/displayRows\.reduce\(/.test(PROC),
    "nothing may be summed from the window — it changes as the user scrolls",
  );
});

test("page-by-page navigation is gone, not merely hidden", () => {
  // The request was explicit about the controls AND the logic: "remove any page-based
  // navigation logic from the UI."
  for (const gone of ["PARTS_PAGE_SIZE", "usePartsPage", "PartsPager", "pageParts", "pageCount", "setPage("]) {
    assert.ok(!PROC.includes(gone), `${gone} must be gone with the pager`);
  }
  assert.ok(!/on this page/.test(PROC), "and the footer note that explained paging");
});

test("spacer rows keep the scrollbar honest without rendering every row", () => {
  // The two <tr>s carrying the height of the rows above and below the window. Without
  // them the scrollbar would describe 60 rows while the table claims 628, and the
  // rendered rows would sit at the top instead of at their real offset.
  assert.match(PROC, /const padTop = win\.start \* ROW_H;/);
  assert.match(PROC, /const padBottom = Math\.max\(0, \(displayRows\.length - win\.end\) \* ROW_H\);/);
  assert.match(PROC, /style=\{\{ height: padTop \}\}/);
  assert.match(PROC, /style=\{\{ height: padBottom \}\}/);
  // Windowing arithmetic needs a known row height, so the rows carry one.
  assert.match(PROC, /style=\{\{ height: ROW_H \}\}/);
});

test("the container is a FIXED height, so the card does not resize with the row count", () => {
  // "Keep the card/table height consistent regardless of how many parts exist."
  assert.match(PROC, /const TABLE_H = "calc\(var\(--app-vh\) \* 0\.62\)";/);
  assert.match(PROC, /style=\{\{ height: TABLE_H \}\}/);
  // Scoped to the TABLE's own scroll container: the Card view is a separate view mode
  // that never had a pager and keeps its max-height, so a file-wide match would be
  // asserting something about the wrong element.
  const at = PROC.indexOf("scrollRef={scrollRef}");
  assert.ok(at > 0, "the table's own container is the one with the window's ref on it");
  const tableScroller = PROC.slice(PROC.lastIndexOf("<DragScroll", at), PROC.indexOf("<table", at));
  assert.ok(!tableScroller.includes("max-h-"), "the old max-height must be gone from it");
});

test("headers and totals stay put; only the rows scroll", () => {
  // Sticky <thead> and a sticky totals row, both INSIDE the one scroll container —
  // which is also what keeps horizontal scrolling working for the wide columns, since
  // the element that scrolls is unchanged.
  assert.match(PROC, /<thead className="sticky top-0 z-\[2\]">/);
  assert.match(PROC, /className="overflow-auto styled-scrollbar"/);
  assert.match(PROC, /<table className="table-fixed border-collapse text-left"/,
    "table-fixed + colgroup is what makes windowing safe: columns do not resize with the rendered rows");
});

test("a drilled-to row is scrolled into the window before it is looked for", () => {
  // PartsListTab finds its target with querySelector and treats a miss as "hidden by a
  // filter". With ~60 rows in the DOM, a perfectly visible row 400 down would miss and
  // report itself as filtered out — so the table puts it in the window first.
  assert.match(PROC, /const i = displayRows\.findIndex\(\(r\) => r\.kind === "part" && String\(r\.p\.id\) === drillKey\);/);
  assert.match(PROC, /el\.scrollTop = Math\.max\(0, i \* ROW_H - el\.clientHeight \/ 2\);/);
  assert.match(PROC, /drillKey=\{drill\.key\}/, "and the key has to reach the table");
});

test("the totals row stays pinned to the bottom while the rows scroll", () => {
  // "Keep the bottom totals/footer fixed if practical." It is: the totals are a
  // <tfoot> inside the same scroll container as the rows, so sticky does the work and
  // the reconciliation strip is never 600 rows away from the top of the list — which
  // is the complaint that produced the pager in the first place, now solved without
  // taking rows away.
  assert.match(PROC, /<tfoot className="sticky bottom-0 z-\[2\]">/);
});
