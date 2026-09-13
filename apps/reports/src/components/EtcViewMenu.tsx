"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, TOOLBAR_MIN_W } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { useGridView } from "@/components/GridViewProvider";
import { ETC_DEPT_GROUPS, nextHiddenGroups } from "@/lib/etc-view";

// Consolidated "View" dropdown for the Monthly ETC toolbar — what used to be three
// separate buttons (Columns, Billable, Grid Size):
//   • Section columns  -> `dept` param (Engineering/Shop)
//   • Job Name column  -> `jobname` param ("0" = hidden)
//   • Billable rows    -> `billables` param (Billable/Non-Billable)
//
// ── What is NOT in here any more (§45) ──────────────────────────────────────
//
// Three size controls: a "Font size" box (--etc-font-size, 4–24px) and Row height /
// Column width steppers (--etc-row-py / --etc-col-px, 0–16px). This menu therefore
// governed the density of ONE tab, and Projects' Display menu governed another with
// its own two steppers and its own two localStorage keys — the split §45 names
// outright ("do not leave different zoom or density settings active on different
// tabs"). All five are replaced by the single sidebar Zoom control; see
// lib/app-zoom.ts. The grid's padding and text size are constants again — the
// numbers those steppers defaulted to — in etc/page.tsx.
//
// One definition, shared with the provider that turns these into `data-col` keys and
// `?dept=` values — see EtcGridView.
const GROUPS = ETC_DEPT_GROUPS;
const BILLABLE = ["Billable", "Non-Billable"] as const;

// `selectedGroups` / `showJobName` used to be props: the server told this menu what it
// had rendered, and the menu echoed it back as a navigation. Both are gone — those two
// controls now read and write GridViewProvider directly, and the server's answer for
// them reaches the provider (as `initialHidden`) rather than the menu. `billables` is
// still a prop because it is still a server-side filter.
export function EtcViewMenu({ selectedBillables }: { selectedBillables: string[] }) {
  // ── Why this menu keeps a local draft (2026-08-04, performance pass) ────────
  //
  // It used to navigate on EVERY tick, with `checked` read straight from a server
  // prop. Measured on the live grid: the checkbox did not visibly change for
  // ~800ms — a full server re-render of 49 jobs x 13 sections had to complete and
  // ship back before the tick appeared. Five ticks were five of those. That is the
  // "filter selections respond slowly" report, and it also explains "the menu
  // closes on me": every tick re-rendered the toolbar under the open panel.
  //
  // useDraftParamsMenu is the pattern the Projects toolbar already used for exactly
  // this reason: the tick lands in local state on the same frame (~7ms), and the URL
  // follows once, 250ms after the last change. The panel stays open throughout —
  // closing it just flushes anything still on the timer.
  //
  // ── Why only `billables` is still on it (§40.2, 2026-08-04) ─────────────────
  //
  // That fixed the CHECKBOX but not the RESULT. A tick still navigated, and the
  // measured cost of the navigation on the production build was 4,113 DOM mutations
  // and ~100ms of blocked main thread to stop showing columns that were already
  // rendered — ~280ms before the grid caught up, against §40.18's 150ms.
  //
  // `dept` and `jobname` are now pure presentation: the grid prints every column and
  // GridViewProvider hides them with one stylesheet rule, so there is no navigation,
  // no payload and no re-render. See lib/grid-view.ts.
  //
  // `billables` stays here deliberately. It filters ROWS, and which rows exist
  // decides `visibleJobs` — the job count in the subtitle, the KPI card figures and
  // the grand totals all derive from it server-side. Hiding rows with CSS would leave
  // every one of those counting jobs that are no longer on screen, which is a wrong
  // number on a financial report rather than a slow one. It is the one filter in this
  // menu that has to ask the server, so it is the one that still does.
  const { draft, toggleValue, pending, detailsRef, detailsProps } = useDraftParamsMenu({
    committed: { billables: selectedBillables },
    buildParams: (d, qs) => {
      // Deliberately NOT deleted when both are selected: `billables` absent means
      // "both", which is the same thing, but the Projects tab writes it explicitly
      // and the two pages should produce identical URLs for identical views.
      qs.set("billables", d.billables.join(","));
    },
  });

  // dept + jobname come from the instant client store instead. `isHidden` is the
  // inverse of the old `checked`, and it moves on the same frame as the click with no
  // request in flight at all — so there is no pending state to show for these two.
  const { isHidden, toggle, setHidden, hidden } = useGridView();

  const billableSet = new Set(draft.billables);
  const groupSet = new Set(GROUPS.filter((g) => !isHidden(g)));
  const jobNameShown = !isHidden("jobname");
  const groupsFiltered = GROUPS.some((g) => !groupSet.has(g));
  const billableFiltered = BILLABLE.some((b) => !billableSet.has(b));
  const anyFilterActive = groupsFiltered || billableFiltered || !jobNameShown;

  // The mount effect that used to restore this grid's saved font size and density from
  // localStorage is gone with those controls (§45). The zoom level is restored once,
  // before first paint, by the script in layout.tsx — so no menu has to remember to do
  // it, and the grid can never paint at one size and jump to another.

  // Click-outside closing and the debounce flush both live in useDraftParamsMenu
  // now, so there is one implementation of "the menu closed, apply what's pending"
  // rather than one per menu.

  // Uncontrolled native <details>: the browser adds/removes `open` on the DOM
  // element as the user toggles it. If React hydrates while it's already open,
  // its VDOM (no `open`) mismatches the DOM (`open=""`) — a benign dev warning.
  // suppressHydrationWarning silences just that attribute check.
  return (
    <details ref={detailsRef} {...detailsProps} suppressHydrationWarning className="group relative inline-block">
      {/* The shared toolbar tokens, not a hand-rolled copy (§41.21). This was
          `rounded-md border px-3.5 py-1.5` with no height token at all, which put it at
          34px and a smaller radius beside 36px `rounded-lg` buttons in the same row —
          the exact drift TOOLBAR_BTN exists to prevent, in the one place that had not
          adopted it. TOOLBAR_MIN_W is what stops it sitting at 76px next to Export's 95. */}
      <summary
        className={`${TOOLBAR_BTN} ${TOOLBAR_MIN_W} justify-center gap-1.5 select-none ${
          anyFilterActive ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL
        }`}
      >
        View
        {anyFilterActive && " (filtered)"}
        {/* The tick is instant and the grid follows ~250ms later, so this is the one
            thing that has to say "the table is catching up" — without it a fast
            ticker would wonder whether the click registered. */}
        {pending && <span className="text-label font-normal opacity-70">updating…</span>}
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className="motion-interactive shrink-0 opacity-70 group-open:rotate-180">
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-56 rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        <p className="px-1.5 pb-1 text-note font-semibold uppercase tracking-wide text-sdc-gray-400">Section columns</p>
        {GROUPS.map((g) => (
          <label key={g} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-sdc-gray-100">
            {/* Unticking the LAST group restores both, rather than leaving an empty
                selection. The grid can never render zero section columns — the URL
                treats "no dept" as "both" — and with a local draft the box would
                otherwise sit unticked while the grid showed the column anyway. The
                old server-driven checkbox snapped back on the next render; this does
                the same thing, immediately and on purpose. */}
            <input
              type="checkbox"
              checked={groupSet.has(g)}
              onChange={() => {
                // The rule (including "unticking the last one restores both") is
                // nextHiddenGroups in lib/etc-view.ts, where it is unit-tested. Keys that
                // are not billing groups — `jobname` — are carried through untouched.
                const others = [...hidden].filter((k) => !GROUPS.includes(k as (typeof GROUPS)[number]));
                setHidden([...others, ...nextHiddenGroups(groupSet, g)]);
              }}
              className="h-3.5 w-3.5 shrink-0"
            />
            <span className="flex-1">{g}</span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-sdc-gray-100">
          <input type="checkbox" checked={jobNameShown} onChange={() => toggle("jobname")} className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">Job Name column</span>
        </label>

        <p className="mt-1 border-t border-sdc-border px-1.5 pb-1 pt-2 text-note font-semibold uppercase tracking-wide text-sdc-gray-400">Rows</p>
        {BILLABLE.map((b) => (
          <label key={b} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-sdc-gray-100">
            <input type="checkbox" checked={billableSet.has(b)} onChange={() => toggleValue("billables", b)} className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">{b}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
