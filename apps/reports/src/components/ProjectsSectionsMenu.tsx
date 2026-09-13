"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { useDraftParamsMenu } from "@/components/useDraftParamMenu";
import { encodeParamList } from "@/lib/quoted-display-prefs";
import { MenuStatus, MenuApplyHint, MenuGroup, MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";
import { useGridView } from "@/components/GridViewProvider";

// "Sections ▾" — which columns the grid shows: the four phase pickers plus the
// info columns (Job/Customer/Type/…), replacing five toolbar buttons.
//
// Two params in one menu, which is why the hook is multi-param: `cols` (section
// codes to show) and `hide` (info columns to hide). They're grouped together
// because from the user's side both answer one question — what's in the grid.
//
// The button reads "Sections (9/11)" so the headline number the old phase
// buttons carried survives the bucketing.

export type PhaseSpec = { phase: string; sections: { code: string; name: string }[] };
export type InfoColumn = { key: string; label: string };
type Key = "cols";

// The remount-on-change wrapper this used to have is gone — the hook resyncs
// its own draft, and with every tick applying immediately a remount would close
// the menu on the first click. See useDraftParamMenu.
export function ProjectsSectionsMenu({
  phases,
  visibleCodes,
  infoColumns,
}: {
  phases: PhaseSpec[];
  visibleCodes: string[];
  infoColumns: InfoColumn[];
  // `hiddenInfo` used to be a prop: the server told this menu which info columns it had
  // omitted, and the menu echoed it back as a navigation. Gone — the info-column boxes
  // read GridViewProvider directly, and the server's answer reaches the provider as
  // `initialHidden` instead.
}) {
  // ── `cols` navigates; `hide` does not (§40.2, 2026-08-04) ───────────────────
  //
  // Both used to be on this hook, so toggling an INFO column paid a full route
  // navigation: measured on the production build at 3,330 DOM mutations and ~440ms of
  // blocked main thread to stop showing one column that was already rendered.
  //
  // Info columns are now pure presentation — the grid prints them always and
  // GridViewProvider hides them with one stylesheet rule, so a tick costs no request
  // and no re-render (see lib/projects-view.ts).
  //
  // `cols` stays here on purpose. Hiding a SECTION column changes the Engineering and
  // Shop hour totals, which the page sums server-side over the visible sections only.
  // Hiding those with CSS would leave both totals counting columns that are no longer
  // on screen — a wrong number rather than a slow one.
  const { draft, setValues, toggleValue, dirty, pending, detailsRef, detailsProps } = useDraftParamsMenu<Key>({
    committed: { cols: visibleCodes },
    buildParams: (d, qs) => {
      // `cols` is always set, even empty: absent means "first visit, use the
      // default section set", not "the user hid everything".
      qs.set("cols", encodeParamList(d.cols ?? []));
    },
  });

  // The info columns' half: instant, no request, no pending state to show.
  const { hidden: hiddenSet, toggle: toggleInfo, setHidden: setHiddenInfo } = useGridView();

  // `phases` (this menu's available options) reflects the signed-in user's
  // Standard Fees permissions directly (quoted/page.tsx's `sectionAllowed`) —
  // unlike before 2026-08-18, it does not depend on Edit Mode, so this menu
  // never needs to know anything about that toggle's own state.
  const cols = draft.cols ?? [];
  // Read from the instant store, not a draft — this moves on the click's own frame.
  const hidden = infoColumns.filter((c) => hiddenSet.has(c.key)).map((c) => c.key);
  const allSections = phases.flatMap((p) => p.sections);
  const shownCount = allSections.filter((s) => cols.includes(s.code)).length;
  const allShown = shownCount === allSections.length && hidden.length === 0;

  // Add/remove a whole phase's codes without touching the other phases'.
  function setPhase(spec: PhaseSpec, checked: boolean) {
    const phaseCodes = spec.sections.map((s) => s.code);
    const rest = cols.filter((c) => !phaseCodes.includes(c));
    setValues("cols", checked ? [...rest, ...phaseCodes] : rest);
  }

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary
        className={`${TOOLBAR_BTN} ${allShown ? TOOLBAR_BTN_NEUTRAL : TOOLBAR_BTN_ACTIVE} ${pending ? "opacity-60" : ""}`}
      >
        Sections
        {` (${shownCount}/${allSections.length})`}
        <MenuStatus pending={pending} />
      </summary>
      <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-2 max-h-[calc(var(--app-vh)_*_0.7)] w-72 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {phases.map((p) => {
          const phaseCodes = p.sections.map((s) => s.code);
          const on = phaseCodes.filter((c) => cols.includes(c)).length;
          return (
            <MenuGroup
              key={p.phase}
              label={p.phase}
              count={`${on}/${phaseCodes.length}`}
              // Every phase open — MenuGroup's default. Fully-on phases used to
              // stay collapsed, so the common case (nothing hidden yet) opened
              // to a menu of closed rows.
            >
              <MenuBulkActions onAll={() => setPhase(p, true)} onNone={() => setPhase(p, false)} />
              {p.sections.map((s) => (
                <MenuCheckbox
                  key={s.code}
                  label={s.name}
                  suffix={s.code}
                  checked={cols.includes(s.code)}
                  onChange={() => toggleValue("cols", s.code)}
                />
              ))}
            </MenuGroup>
          );
        })}
        {/* Info columns last: they're the job metadata, not the hours matrix, and
            they're changed far less often than the phase columns. */}
        <MenuGroup
          label="Info columns"
          count={`${infoColumns.length - hidden.length}/${infoColumns.length}`}
        >
          <MenuBulkActions onAll={() => setHiddenInfo([])} onNone={() => setHiddenInfo(infoColumns.map((c) => c.key))} />
          {infoColumns.map((c) => (
            <MenuCheckbox
              key={c.key}
              label={c.label}
              // The store tracks HIDDEN keys to match the param; inverted once
              // here rather than twice on the way to the URL.
              checked={!hiddenSet.has(c.key)}
              onChange={() => toggleInfo(c.key)}
            />
          ))}
        </MenuGroup>
        <MenuApplyHint dirty={dirty} />
      </div>
    </details>
  );
}
