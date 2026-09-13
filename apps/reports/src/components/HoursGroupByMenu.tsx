"use client";

import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { useDraftGroupByMenu } from "@/components/useDraftGroupByMenu";
import { MenuStatus, MenuApplyHint } from "@/components/MenuStatus";
import { HOURS_GROUP_BY_VALUES, HOURS_GROUP_BY_LABEL, type HoursGroupBy } from "@/lib/hours-filters";

// "Group By ▾" — replaces the old single-dimension chip row entirely. Selecting more
// than one dimension nests the table (see HoursGroupedTree.tsx); order is meaningful
// (Job -> Employee nests differently than Employee -> Job), which is why this can't
// reuse HoursFilterMenu's checkbox-bucket mechanism as-is — see useDraftGroupByMenu's
// header for exactly why.
//
// No native drag-and-drop: zero precedent anywhere in this app, weak touch/keyboard
// support without extra work, and a real integration risk with the click-outside-
// closes-the-<details> handler every one of these toolbar menus already relies on.
// Plain ▲▼ buttons satisfy "reorder if practical" without that risk.

function activeLabel(levels: HoursGroupBy[]): string {
  if (levels.length === 0) return "Group By";
  return `Group By: ${levels.map((l) => HOURS_GROUP_BY_LABEL[l]).join(" → ")}`;
}

export function HoursGroupByMenu({ groupBy }: { groupBy: HoursGroupBy[] }) {
  const { draft, toggle, moveUp, moveDown, clear, dirty, pending, detailsRef, detailsProps } = useDraftGroupByMenu({
    committed: groupBy,
    buildParams: (d, qs) => {
      if (d.length > 0) qs.set("groupBy", d.join(","));
      else qs.delete("groupBy");
      qs.delete("page");
    },
  });

  const active = draft.length > 0;

  return (
    <details ref={detailsRef} {...detailsProps} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${active ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL} ${pending ? "opacity-60" : ""}`}>
        {activeLabel(draft)}
        <MenuStatus pending={pending} />
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-sdc-border bg-white p-2.5 shadow-lg">
        <p className="mb-1.5 text-note text-sdc-gray-600">Nest the table by one or more fields, in the order checked.</p>
        <div className="flex flex-col gap-0.5">
          {HOURS_GROUP_BY_VALUES.map((dim) => {
            const pos = draft.indexOf(dim);
            const checked = pos !== -1;
            return (
              <div key={dim} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-sdc-gray-100">
                <label className="flex flex-1 cursor-pointer items-center gap-2 text-xs">
                  <input type="checkbox" checked={checked} onChange={() => toggle(dim)} className="h-3.5 w-3.5 shrink-0" />
                  <span className="flex-1">{HOURS_GROUP_BY_LABEL[dim]}</span>
                </label>
                {checked && (
                  <>
                    <span className="shrink-0 font-mono text-label text-sdc-gray-400">{pos + 1}</span>
                    <button
                      type="button"
                      onClick={() => moveUp(pos)}
                      disabled={pos === 0}
                      aria-label={`Move ${HOURS_GROUP_BY_LABEL[dim]} earlier`}
                      className="shrink-0 rounded px-1 text-sdc-muted hover:bg-sdc-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => moveDown(pos)}
                      disabled={pos === draft.length - 1}
                      aria-label={`Move ${HOURS_GROUP_BY_LABEL[dim]} later`}
                      className="shrink-0 rounded px-1 text-sdc-muted hover:bg-sdc-gray-200 disabled:cursor-not-allowed disabled:opacity-30"
                    >
                      ▼
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2 border-t border-sdc-border-soft pt-2">
          <button
            type="button"
            onClick={clear}
            disabled={draft.length === 0}
            className="rounded px-1.5 py-0.5 text-note font-medium text-sdc-blue hover:bg-sdc-blue-light disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
          <MenuApplyHint dirty={dirty} />
        </div>
      </div>
    </details>
  );
}
