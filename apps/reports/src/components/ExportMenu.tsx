"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { flushEtcAutosave, isEtcDirty } from "@/lib/etc-dirty-tracker";
import { useAnchoredPosition } from "@/lib/use-anchored-position";

// ── Export ▾ (§24.1) ─────────────────────────────────────────────────────────
//
// One control on both pages: a button that opens Excel / CSV. It sends the page's OWN
// query string to /api/export/<report>, which is what makes the file match the table
// (§24.2) — the filters are not re-described here, they are simply forwarded.
//
// ── Why fetch + blob rather than a plain <a download> ───────────────────────
//
// A link is simpler and was the first version, but it cannot do three of the required
// things: it gives no progress state, it cannot tell success from failure (a 500 lands
// in a download slot and looks like nothing happened), and it cannot wait for the
// autosave to flush first. So the file is fetched, the response is checked, and only
// then is it handed to the browser as a download.
//
// The page never navigates and never reloads: the anchor is synthetic, revoked
// immediately, and the manager's filters, scroll position and open menus are untouched
// (§24.12).
export function ExportMenu({
  report,
  // Extra params the page owns that are not in the URL — the ETC month, which lives in
  // the query string already, is passed explicitly so a default month (no ?month=) still
  // exports the month on screen rather than the server's idea of "latest".
  fixedParams,
  // Wait for pending edits to land before exporting (§24.8). Only the ETC page has
  // autosaved cells feeding its export.
  flushBeforeExport = false,
  // Hours only: which pre-punch eras the current filters reach. When either is
  // present, "Export to Excel" asks first whether to append them as extra sheets;
  // when neither is (the common case), it exports straight away, exactly as before.
  historicalEras,
  className,
}: {
  report: "projects" | "etc" | "hours";
  fixedParams?: Record<string, string>;
  flushBeforeExport?: boolean;
  historicalEras?: { migration: boolean; frozenEtc: boolean };
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The "include historical sheets?" dialog, and its two choices. Both start ticked:
  // anyone who reaches the dialog has data in those eras, and the usual reason to
  // want this export is to reconcile against a total that already includes them.
  const [askHistorical, setAskHistorical] = useState(false);
  const [includeMigration, setIncludeMigration] = useState(true);
  const [includeFrozenEtc, setIncludeFrozenEtc] = useState(true);
  const offerHistorical = Boolean(historicalEras?.migration || historicalEras?.frozenEtc);
  // Which format is being prepared, so only that item shows a spinner and only the
  // export action is disabled — not the page (§24.9).
  const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
  const searchParams = useSearchParams();
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  // ── Portal + anchored positioning (found live) ────────────────────────────
  //
  // The panel used to be `absolute left-0 top-full` inside a wrapper around the
  // button — fine on its own, but this control sits in toolbars that themselves live
  // inside a horizontally- or vertically-scrolling container (the Hours tab's table
  // wrapper is one), and an `absolute` element is still clipped by any ancestor
  // between it and its containing block that sets `overflow` to anything but
  // `visible`. A portal into `document.body`, positioned with `fixed` coordinates
  // computed from the BUTTON's own rect (§25.1: not a wrapper div around it, which
  // is one more layer that could ever legitimately differ in size from the button
  // itself), escapes every ancestor's overflow/clipping entirely — same fix
  // JobCellMenuHost.tsx already uses for its own right-click menu, generalized into
  // use-anchored-position.ts's `side`/`align` hook so any future portaled menu that
  // needs "open under THIS element, right edges flush" doesn't reinvent it.
  //
  // side="bottom" + align="end": opens directly below the button, right edges
  // flush. This control sits at the right end of every toolbar that uses it (Hours,
  // Projects, Monthly ETC) — align="end" means the common case (room to the left,
  // since Export is the last button) never needs to shift at all, and the panel
  // reads as belonging to Export specifically rather than to whichever control
  // happened to be nearby (Views, in the report that prompted this fix, §25).
  const pos = useAnchoredPosition(btnRef, menuRef, open, { side: "bottom", align: "end", sideOffset: 4 });

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // `capture` so a scroll inside a nested container (which doesn't bubble to
    // window) still closes the menu instead of leaving it anchored to a button
    // that has since moved out from under it.
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  useEffect(() => {
    if (!askHistorical) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAskHistorical(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [askHistorical]);

  function confirmHistorical() {
    setAskHistorical(false);
    const extra: Record<string, string> = {};
    if (historicalEras?.migration && includeMigration) extra.includeMigration = "1";
    if (historicalEras?.frozenEtc && includeFrozenEtc) extra.includeFrozenEtc = "1";
    void run("xlsx", extra);
  }

  async function run(format: "xlsx" | "csv", extraParams?: Record<string, string>) {
    if (busy) return; // one click, one export (§24.13.20)
    setBusy(format);
    try {
      // The export reads the DATABASE, so anything still on the autosave debounce would
      // be missing from the file. Same step the monthly submission takes, same reason.
      if (flushBeforeExport && isEtcDirty()) await flushEtcAutosave();

      const qs = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(fixedParams ?? {})) if (!qs.has(k)) qs.set(k, v);
      for (const [k, v] of Object.entries(extraParams ?? {})) qs.set(k, v);
      qs.set("format", format);

      const res = await fetch(`/api/export/${report}?${qs.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        // The route returns a plain-text reason; showing it beats "export failed".
        throw new Error((await res.text()) || `The server returned ${res.status}.`);
      }
      const blob = await res.blob();
      // The filename the server chose (§24.10) — it knows the filters and the month.
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = match?.[1] ?? `export.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick: revoking synchronously can beat the download starting
      // in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      toast(`${a.download} downloaded.`, "success");
      setOpen(false);
    } catch (err) {
      toast(err instanceof Error ? `Export failed — ${err.message}` : "Export failed.", "error");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        disabled={busy !== null}
        onClick={() => setOpen((v) => !v)}
        title="Download this table as it is currently filtered"
      >
        {/* Reserved slot: "Export" and "Preparing…" are different widths, and this button
            sits mid-toolbar — swapping them shifted every control to its right (§36.3,
            §36.14). */}
        <span className="inline-flex min-w-[4.5rem] items-center justify-center">{busy ? "Preparing…" : "Export"}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: pos?.top ?? 0,
              left: pos?.left ?? 0,
              visibility: pos ? "visible" : "hidden",
              // zIndex 60, clearing the sticky grid headers (z-20) and every other
              // menu's own stacking context in the app — same value
              // JobCellMenuHost.tsx's portal uses (also inline, not a `z-*` class:
              // 60 isn't on Tailwind's default scale), for the same reason: a
              // portaled menu should always win.
              zIndex: 60,
            }}
            className="motion-menu-panel w-56 rounded-lg border border-sdc-border bg-white p-1 shadow-lg"
          >
            {/* Says what the export contains, because "Export" alone leaves the reader
                guessing whether it is the filtered view or everything. */}
            <p className="px-2 py-1 text-label leading-snug text-sdc-muted">
              Exports the table as currently filtered, with every column — including the ones off-screen.
            </p>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                // CSV below is never intercepted: one table can't carry the extra
                // sheets, and the route ignores the flags for it anyway.
                if (offerHistorical) {
                  setOpen(false);
                  setAskHistorical(true);
                } else {
                  void run("xlsx");
                }
              }}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-sdc-navy hover:bg-sdc-blue-light disabled:opacity-50"
            >
              Export to Excel
              <span className="text-label text-sdc-gray-400">{busy === "xlsx" ? "preparing…" : ".xlsx"}</span>
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run("csv")}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-sdc-navy hover:bg-sdc-blue-light disabled:opacity-50"
            >
              Export to CSV
              <span className="text-label text-sdc-gray-400">{busy === "csv" ? "preparing…" : ".csv"}</span>
            </button>
          </div>,
          document.body,
        )}
      {/* ── Include the pre-punch eras? (Hours only) ─────────────────────────────
          Same modal shape as SubmitReportAction's confirmation: the backdrop click
          and Escape cancel, and nothing exports until the button is pressed. Only
          the eras that actually have data under the current filters get a box. */}
      {askHistorical &&
        createPortal(
          <div
            className="motion-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setAskHistorical(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="export-historical-title"
              aria-describedby="export-historical-body"
              className="motion-dialog w-full max-w-md rounded-xl border border-sdc-border bg-white p-5 shadow-xl"
            >
              <h2 id="export-historical-title" className="mb-2 text-sm font-semibold text-sdc-navy">
                Include historical hours?
              </h2>
              <p id="export-historical-body" className="mb-4 text-xs leading-relaxed text-sdc-gray-600">
                These filters include hours from before punch tracking began, or from months that closed before it caught up. Those
                exist only as period totals, not individual punches, so they can&apos;t appear as rows in the main sheet. Include them
                as extra sheets?
              </p>
              <div className="mb-4 flex flex-col gap-2">
                {historicalEras?.migration && (
                  <label className="flex items-start gap-2 text-sm text-sdc-navy">
                    <input type="checkbox" className="mt-0.5" checked={includeMigration} onChange={(e) => setIncludeMigration(e.target.checked)} />
                    <span>
                      Migration snapshot totals
                      <span className="block text-label text-sdc-muted">One total per job and section, from the original Excel migration.</span>
                    </span>
                  </label>
                )}
                {historicalEras?.frozenEtc && (
                  <label className="flex items-start gap-2 text-sm text-sdc-navy">
                    <input type="checkbox" className="mt-0.5" checked={includeFrozenEtc} onChange={(e) => setIncludeFrozenEtc(e.target.checked)} />
                    <span>
                      Frozen month totals
                      <span className="block text-label text-sdc-muted">Monthly ETC hours for months the punch import doesn&apos;t cover.</span>
                    </span>
                  </label>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setAskHistorical(false)}
                  className="motion-interactive rounded-md px-3 py-1.5 text-sm text-sdc-gray-600 hover:bg-sdc-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  autoFocus
                  onClick={confirmHistorical}
                  className="motion-interactive rounded-md bg-sdc-blue px-3 py-1.5 text-sm font-semibold text-white hover:bg-sdc-blue-dark"
                >
                  Export to Excel
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
