"use client";

import { useEffect } from "react";
import { readEtcLiveTotals, readEtcLiveFooterTotals, readPartsBreakoutTotals, subscribeEtcLiveTotals } from "@/lib/etc-live-totals";
// `usd` is byte-identical to etc/page.tsx's local currency() — same options, same
// output — so the Parts Cost footer keeps formatting exactly as the server
// rendered it rather than through a fourth private copy of the formatter.
import { hours as formatHours, usd as formatUsd, usdExact } from "@/components/ui/format";
import { diffCellStyle, diffTotalStyle, DIFF_CEILING } from "@/components/ui/etc-diff-colors";
import { changedForFlash, FLASH_MS, prefersReducedMotion } from "@/lib/motion";

// Repaints the Monthly ETC grid's rollup cells from the live store as New ETC
// values are typed — the row's TOTAL (NEW ETC) block and the sticky grand-total
// row in <tfoot>.
//
// See lib/etc-live-totals.ts for why: every one of those figures is summed on the
// server, so a manager confirming cell by cell watched each Diff update correctly
// while the totals they were about to Submit sat frozen at page load.
//
// ── Only two cells per block move ───────────────────────────────────────────
// Prior ETC and Hours Worked are not editable here (Hours Worked auto-syncs from
// the hours feed), and Hours Left derives from those two. So typing a New ETC can
// only change Total New ETC and Diff. Repainting just those keeps this narrow and
// makes it obvious what it can and cannot get wrong.
//
// ── Why DOM writes and not React ────────────────────────────────────────────
// The rows are server-rendered precisely so ~800 cells stay out of the client
// bundle. Re-rendering them through React on every keystroke is the cost that
// choice exists to avoid, so the totals are patched in place instead — the same
// approach as ProjectsLiveTotals on the Projects grid.
//
// It never invents a number: it only sums what the cells published, and the cells
// publish what they themselves computed with lib/etc.ts. A live total therefore
// cannot disagree with the figures above it, or with what Submit persists.
//
// ── No monthComplete prop any more (2026-08-04) ─────────────────────────────
// It used to take one, and used it to render "—" instead of the Total New ETC
// figure until the month's actuals were complete. That is why the bottom totals
// "were not updating": on an in-progress month every New ETC total was a dash, and
// no amount of typing could move a dash. The gate belongs on the CELLS (where it
// stops a partial figure looking final — see newEtcSeedText) and never on a total,
// whose whole contract is to equal the sum of what is displayed above it.
export function EtcLiveTotals() {
  useEffect(() => {
    // ── Which totals just moved, and whether to say so (§36.6) ──────────────
    //
    // §36.6 asks for "a subtle, brief highlight when a value is successfully updated"
    // and, two lines later, "do not animate every cell during large refreshes". Both
    // apply here, because this one function paints in two completely different
    // situations: a keystroke, which moves two or three totals, and a Refresh Data /
    // filter change / month switch, which can move every total on the page.
    //
    // So the painter records what each cell LAST HELD, and asks lib/motion.ts which of
    // them changed. Above the cap that is a bulk update and nothing flashes — a grid
    // strobing forty cells at once is not feedback, it is noise, and forty
    // simultaneous animations is the main-thread cost §36.15 asks to avoid.
    //
    // Keyed on the rendered TEXT rather than the number: these cells print whole hours
    // and whole dollars, so a change that rounds to the same string is not a change
    // anybody can see, and flashing for it would be the grid crying wolf.
    const lastText = new Map<string, string>();
    // Collected during a paint, applied at the end — a flash decision needs the whole
    // set before it can tell an edit from a bulk update.
    let touched = new Map<string, HTMLElement>();
    let nextText = new Map<string, string>();
    // No JS at all when the viewer has asked for reduced motion (§36.16): the class is
    // simply never applied, rather than applied to an element whose animation the
    // stylesheet has just disabled.
    const reduced = prefersReducedMotion();

    // Records a cell's new text and hands back whether it needs writing. Every writer
    // below goes through this, so no cell can be flashed without being tracked or
    // tracked without being flashed.
    const note = (key: string, cell: HTMLElement, text: string) => {
      nextText.set(key, text);
      touched.set(key, cell);
    };

    const applyFlashes = () => {
      const { keys, bulk } = changedForFlash(lastText, nextText);
      for (const [key, text] of nextText) lastText.set(key, text);
      nextText = new Map();
      const cells = touched;
      touched = new Map();
      if (reduced || bulk || keys.length === 0) return;
      for (const key of keys) {
        const cell = cells.get(key);
        if (!cell) continue;
        // Removed before re-adding, so a cell that moves twice inside one flash window
        // restarts its animation instead of ignoring the second change. Two frames of
        // separation are not needed — the class is absent for a full paint here because
        // this runs inside the store's notification, not inside the same style
        // recalculation.
        cell.classList.remove("motion-flash");
        // Force the removal to take effect before re-adding, so the animation restarts.
        // Reading offsetWidth is the standard flush; it is one read on at most
        // FLASH_CAP cells, not per frame.
        void cell.offsetWidth;
        cell.classList.add("motion-flash");
        window.setTimeout(() => cell.classList.remove("motion-flash"), FLASH_MS);
      }
    };

    const paint = () => {
      const totals = readEtcLiveTotals();

      // Grand totals are re-summed from the same per-job figures rather than
      // accumulated separately, so the footer can't drift from the rows it sums.
      const grand = {
        Engineering: { newEtc: 0, diff: 0 },
        Shop: { newEtc: 0, diff: 0 },
      };

      for (const [jobId, t] of totals) {
        // The Parts Cost row's own Diff. Repainted from the published parts cell because
        // that cell's input lives in a client component while its Diff <td> is rendered by
        // the page — so unlike the hours columns, local state cannot reach it.
        if (t.parts) writePartsRowDiff(String(jobId), t.parts.diff, t.parts.decided);
        for (const group of ["Engineering", "Shop"] as const) {
          const g = group === "Engineering" ? t.engineering : t.shop;
          // ── The block is all-or-nothing (§51) ──────────────────────────
          //
          // `g.rollup` is null until every section in this group that needs a New ETC
          // has one, and the two cells go blank with it. The grand total below sums
          // only the rows that HAVE a figure — an incomplete row adds nothing, not a
          // zero and not its Hours Left (§51 #7, #8).
          //
          // Deliberately NOT g.newEtc / g.diff, which stay exactly as they were: those
          // feed the KPI strip, and §51 changes this block only.
          const { newEtc, diff } = g.rollup;
          if (newEtc != null) grand[group].newEtc += newEtc;
          if (diff != null) grand[group].diff += diff;
          write(String(jobId), group, "newEtc", newEtc);
          write(String(jobId), group, "diff", diff);
        }
      }
      for (const group of ["Engineering", "Shop"] as const) {
        write("all", group, "newEtc", grand[group].newEtc);
        write("all", group, "diff", grand[group].diff);
      }

      // ── The rest of the <tfoot> ──────────────────────────────────────────
      // The per-section grand total is the figure directly beneath the cell
      // being typed, and it had no hook at all until 2026-08-03 — so the most
      // closely watched total on the page was the one that never moved. Parts
      // Cost's footer had the same gap despite its New ETC column being
      // editable. See lib/etc-live-totals.ts.
      const footer = readEtcLiveFooterTotals();
      for (const [sectionCode, t] of footer.sections) {
        writeSection(sectionCode, "newEtc", t.newEtc);
        writeSection(sectionCode, "diff", t.diff);
      }
      writeParts("partsNewEtc", footer.parts.newEtc);
      writeParts("partsDiff", footer.parts.diff);
      // Left to Invoice / Left to Purchase are typed columns (2026-09-03), so their
      // footers move with them. Read straight from the breakout store rather than
      // through SectionTotals: these two are not ETC figures, they are the inputs New
      // ETC is calculated from, and nothing else sums them.
      const breakoutTotals = readPartsBreakoutTotals();
      writeParts("partsLeftToInvoice", breakoutTotals.invoice);
      writeParts("partsLeftToPurchase", breakoutTotals.purchase);

      // Last, once every writer has reported: only now is it possible to tell a
      // two-cell edit from a whole-grid refresh.
      applyFlashes();
    };

    // Repaint a Diff cell's COLOUR, not just its number.
    //
    // Without this the number moved and the colour didn't, so a total that crossed
    // zero kept the colour of the value it used to hold — "-124" still tinted green
    // as though it were under plan. A number and a colour contradicting each other is
    // worse than either being stale alone, because the colour is what gets read at a
    // glance on a grid this dense.
    //
    // The colour is a magnitude gradient, so it is an inline style rather than a
    // class — the same computed value the server render applies (etc-diff-colors.ts).
    // Both properties are cleared before reapplying, because an empty style object is
    // how "no variance" is expressed and a leftover colour would survive it.
    const paintDiffColor = (cell: HTMLElement, value: number, onDark: boolean, ceiling: number) => {
      const style = onDark ? diffTotalStyle(value, ceiling) : diffCellStyle(value, ceiling);
      cell.style.backgroundColor = "backgroundColor" in style && style.backgroundColor ? style.backgroundColor : "";
      cell.style.color = style.color ?? "";
      cell.style.fontWeight = "fontWeight" in style && style.fontWeight ? String(style.fontWeight) : "";
    };

    const write = (job: string, group: string, kind: "newEtc" | "diff", value: number | null) => {
      const cell = document.querySelector<HTMLElement>(`[data-live="${kind}"][data-group="${group}"][data-job="${job}"]`);
      if (!cell) return; // row filtered out, or this group's columns hidden
      // ── null means BLANK, and blank is a state, not a missing render (§51) ──
      //
      // A row whose group still has an unanswered section shows nothing here. The
      // colour has to be cleared with the text: a leftover tint on an empty cell is
      // the same contradiction paintDiffColor was written to prevent, one step worse
      // — it would imply a variance that is not being reported at all.
      //
      // The server render seeds the tooltip with WHICH sections are outstanding, so it
      // is left alone rather than overwritten with a number that does not exist.
      if (value == null) {
        cell.textContent = "";
        note(`${kind}|${group}|${job}`, cell, "");
        if (kind === "diff") {
          cell.style.backgroundColor = "";
          cell.style.color = "";
          cell.style.fontWeight = "";
        }
        return;
      }
      // A COMPLETE total always shows its sum (2026-08-04). It used to render "—" until
      // the month's actuals were complete, which is why the bottom totals "were not
      // updating": on any in-progress month the New ETC totals were a dash that no
      // amount of typing could move. A total's contract is to equal the sum of the
      // values displayed above it — see the note in etc/page.tsx.
      const text = formatHours(value);
      cell.textContent = text;
      note(`${kind}|${group}|${job}`, cell, text);
      cell.setAttribute("title", String(Math.round(value * 100) / 100));
      // Body rows colour the cell background; the footer row (data-job="all") is dark
      // and colours the text instead. Both are hours rollups, so both scale against
      // the same ceiling — matching what the server rendered for these cells.
      if (kind === "diff") paintDiffColor(cell, value, job === "all", DIFF_CEILING.hoursTotal);
    };

    // Per-section footer totals. Keyed on the section code alone — there is one
    // footer row, so no job dimension. The selector deliberately shares nothing
    // with the group hooks above (those require data-group + data-job), so the
    // two can never match each other's cells.
    const writeSection = (sectionCode: string, kind: "newEtc" | "diff", value: number) => {
      const cell = document.querySelector<HTMLElement>(`[data-live="${kind}"][data-section="${sectionCode}"]`);
      if (!cell) return; // column hidden by the Columns filter
      const text = formatHours(value);
      cell.textContent = text;
      note(`section|${kind}|${sectionCode}`, cell, text);
      cell.setAttribute("title", String(Math.round(value * 100) / 100));
      // Always in the dark <tfoot> — there is only one footer row.
      if (kind === "diff") paintDiffColor(cell, value, true, DIFF_CEILING.hoursTotal);
    };

    // The Parts Cost row Diff — dollars, in the BODY, so it colours a background like the
    // hours cells rather than text like the footer. Prints "—" when nothing is decided,
    // matching the server render: with no New ETC chosen there is no variance, and "$0"
    // would read as "on plan".
    // ALWAYS a figure (2026-08-04, by request): Diff = Money Left − New ETC, with a
    // blank New ETC counting as 0. It used to print "—" while nothing was decided;
    // `decided` now only affects nothing here, but is still received because the
    // publisher carries it for the cell background.
    const writePartsRowDiff = (job: string, value: number, decided: boolean) => {
      const cell = document.querySelector<HTMLElement>(`[data-live="partsRowDiff"][data-job="${job}"]`);
      if (!cell) return; // Parts Cost column hidden, or this job has no parts row
      // ── Blank while nothing is decided (§29.2) ─────────────────────────────
      //
      // `decided` used to be received and ignored, on the since-reverted rule that a
      // blank New ETC counted as 0 and the cell should print the resulting figure. It
      // is load-bearing again: an undecided cell shows NOTHING — no zero, no Money
      // Left, no leftover from before it was cleared — which is what the hours Diff
      // cells beside it do, and what clearing a value has to leave behind.
      if (!decided) {
        cell.textContent = "";
        note(`partsRowDiff|${job}`, cell, "");
        cell.removeAttribute("title");
        paintDiffColor(cell, 0, false, DIFF_CEILING.moneyCell);
        return;
      }
      cell.textContent = formatUsd(value);
      note(`partsRowDiff|${job}`, cell, formatUsd(value));
      cell.setAttribute(
        "title",
        usdExact(value),
      );
      paintDiffColor(cell, value, false, DIFF_CEILING.moneyCell);
    };

    // ── The Parts Cost under-planning warning was REMOVED (2026-09-04) ─────
    //
    // `writePartsRisk` painted every `[data-parts-risk]` cell in a row red as the New
    // ETC box was typed in. Removed by request along with the server-side first paint:
    // "do not use row-level red backgrounds for Parts Cost". Both halves had to go
    // together — a live repaint with no first paint, or the reverse, is worse than
    // either. Diff still recolours in its own cell.

    // Parts Cost footer — dollars, not hours, and one cell each.
    const writeParts = (
      kind: "partsNewEtc" | "partsDiff" | "partsLeftToInvoice" | "partsLeftToPurchase",
      value: number,
    ) => {
      const cell = document.querySelector<HTMLElement>(`[data-live="${kind}"]`);
      if (!cell) return;
      const text = formatUsd(value);
      cell.textContent = text;
      note(`parts|${kind}`, cell, text);
      cell.setAttribute("title", usdExact(value));
      if (kind === "partsDiff") paintDiffColor(cell, value, true, DIFF_CEILING.moneyTotal);
    };

    paint();
    return subscribeEtcLiveTotals(paint);
  }, []);

  return null;
}
