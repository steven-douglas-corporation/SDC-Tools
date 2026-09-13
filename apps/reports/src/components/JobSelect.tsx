"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";
import { INPUT } from "@/components/ui/classnames";
import { groupSelectionState, nextSelectionForGroup } from "@/lib/job-select-groups";
import {
  JOB_HOURS_SELECTION_COOKIE,
  JOB_HOURS_SELECTION_LEGACY_KEY,
  rememberJobHoursSelection,
} from "@/lib/job-hours-selection";

// Searchable MULTI-job picker for the Job Hour Details slicer. Writes
// ?jobs=<jobId,jobId,…>, which the page has always aggregated.
//
// This was a multi-select once before and got cut back to one job, because
// "remove the selected job" could never work: the server falls back to its
// data-richest default whenever ?jobs= is absent (defaultDashboardJobId), so
// clearing the last chip instantly re-selected job 1142 and read as a broken
// control.
//
// Multi-select is back, with that root cause fixed rather than worked around —
// clearing now writes an EMPTY `?jobs=`, which is present-but-empty and so means
// "deliberately nothing" instead of "no choice made yet". The page checks for
// that and shows its empty state rather than helpfully re-picking a job the user
// just removed. See the `explicitlyEmpty` note in job-hours/page.tsx.
//
// Picking does NOT close the menu, unlike the single-job version: the whole
// point is choosing several, and a menu that shut after each one would make
// selecting four jobs a four-times-reopen chore. Outside click or Esc closes it.
type JobOpt = { id: number; jobId: string; jobName: string; status: string | null };

// Status groups, in the order they appear in the list. Active leads because
// that's what nearly every lookup is for; the Power BI slicer this mirrors
// happens to sort "(Blank)" first, which buries the useful group. Any status not
// named here falls in between, alphabetically, so a new one added to the data
// shows up without a code change. Jobs with no status land in "(Blank)", the
// same label the Power BI slicer uses.
const BLANK_GROUP = "(Blank)";
const GROUP_ORDER_HEAD = ["Active"];
const GROUP_ORDER_TAIL = [BLANK_GROUP];

function groupRank(name: string): [number, string] {
  const head = GROUP_ORDER_HEAD.indexOf(name);
  if (head !== -1) return [head, ""];
  const tail = GROUP_ORDER_TAIL.indexOf(name);
  if (tail !== -1) return [2, String(tail)];
  return [1, name.toLowerCase()];
}

export function JobSelect({ jobs, selected }: { jobs: JobOpt[]; selected: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) detailsRef.current.open = false;
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && detailsRef.current?.open) detailsRef.current.open = false;
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // ── Remembering the last selection: now the SERVER's job ──────────────────
  //
  // This effect used to read localStorage on mount and `router.replace` the URL
  // to the remembered job. That is what made a bare /job-hours landing render
  // job 1130's hours, charts, parts and procurement for a beat before swapping
  // to the job the user wanted: the server had already rendered its default by
  // the time this code could run, because localStorage does not exist until
  // after hydration.
  //
  // The selection is a cookie now (lib/job-hours-selection.ts), written in
  // `apply()` below and read by the page during its FIRST render — so the wrong
  // job is never rendered, never fetched, and there is no second navigation.
  //
  // What remains here is a one-time migration for browsers that still hold the
  // old localStorage value and no cookie yet. It writes the cookie and does the
  // same replace this code always did, so an existing user's remembered job
  // survives the deploy; it can only ever run once per browser, and every
  // landing after it is resolved server-side.
  useEffect(() => {
    if (document.cookie.includes(`${JOB_HOURS_SELECTION_COOKIE}=`)) return;
    let stored: string | null = null;
    try { stored = window.localStorage.getItem(JOB_HOURS_SELECTION_LEGACY_KEY); } catch { /* ignore */ }
    if (!stored) return;
    const ids = stored.split(",").map((s) => s.trim()).filter(Boolean);
    rememberJobHoursSelection(ids);
    try { window.localStorage.removeItem(JOB_HOURS_SELECTION_LEGACY_KEY); } catch { /* ignore */ }
    const sp = new URLSearchParams(window.location.search);
    if (sp.has("jobs") || sp.has("job") || ids.length === 0) return;
    sp.set("jobs", ids.join(","));
    router.replace(`${pathname}?${sp.toString()}`);
    // Run once on mount — a stored value only matters for the initial landing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => j.jobId.includes(q) || j.jobName.toLowerCase().includes(q));
  }, [jobs, query]);

  // Grouped by Job Status, like the Power BI slicer. Built from the FILTERED
  // list so a search narrows the groups too — and drops any group left empty
  // rather than showing a header with nothing under it.
  const groups = useMemo(() => {
    const byStatus = new Map<string, JobOpt[]>();
    for (const j of filtered) {
      const key = j.status?.trim() ? j.status : BLANK_GROUP;
      const list = byStatus.get(key);
      if (list) list.push(j);
      else byStatus.set(key, [j]);
    }
    return [...byStatus.entries()]
      .map(([name, items]) => ({ name, items }))
      .sort((a, b) => {
        const [ra, sa] = groupRank(a.name);
        const [rb, sb] = groupRank(b.name);
        return ra - rb || sa.localeCompare(sb);
      });
  }, [filtered]);

  // Which groups the user has explicitly toggled. Absent from the map = use the
  // default (below), so a brand-new status group behaves sensibly without ever
  // having been clicked.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  // The group holding the FIRST selection — enough to make at least one ✓
  // visible on open without expanding half the list.
  const selectedStatus = selected.length ? jobs.find((j) => j.jobId === selected[0])?.status : null;
  function isOpen(name: string): boolean {
    if (name in overrides) return overrides[name];
    // While searching, open everything — a collapsed group would hide the match
    // the user just typed and read as "no results".
    if (query.trim()) return true;
    // Otherwise: Active, plus whichever group holds the current job, so the ✓ is
    // visible on open without any hunting. Everything else starts collapsed —
    // that's the point of grouping a 300-job list.
    if (name === "Active") return true;
    return name === (selectedStatus?.trim() ? selectedStatus : BLANK_GROUP);
  }

  // Writes the selection to the URL. An EMPTY list still writes `jobs=` rather
  // than deleting the param — that difference is what stops the server helpfully
  // re-selecting a default job the moment you remove the last one.
  function apply(next: string[]) {
    // nextParams: jobs are added one chip at a time, so the second click
    // regularly lands before the first has committed — and until it does,
    // useSearchParams still reports the older query string. See
    // lib/url-params.ts.
    const currentQs = searchParams.toString();
    const qs = nextParams(currentQs);
    qs.set("jobs", next.join(","));
    qs.delete("job"); // drop the legacy single-job param
    // Remembered for the next landing, where the SERVER reads it. An empty
    // selection deletes the cookie rather than storing "" — see
    // selectionCookieAssignment.
    rememberJobHoursSelection(next);
    const q = qs.toString();
    notePendingParams(currentQs, q);
    router.push(`${pathname}?${q}`, { scroll: false });
  }

  // Add or remove one job, keeping the order the list is shown in so the chips
  // and the ?jobs= param don't reshuffle as you click.
  function toggle(jobId: string) {
    const next = selectedSet.has(jobId)
      ? selected.filter((s) => s !== jobId)
      : jobs.filter((j) => j.jobId === jobId || selectedSet.has(j.jobId)).map((j) => j.jobId);
    apply(next);
  }

  // ── Selecting a whole status group (2026-08-24, by request) ───────────────
  //
  // "☑ Active — 59" in one click, because picking 59 jobs individually is the
  // thing this filter was slowest at.
  //
  // Both of these go through the SAME apply() every individual click uses, which
  // is what makes the performance requirement fall out for free rather than
  // needing a batching layer: apply() writes the complete next selection in one
  // router.push, so selecting 59 jobs is one navigation and one refetch, not 59.
  // There is deliberately no separate group-filtering path — the URL's `jobs=`
  // list stays the single source of truth, so a group selection filters exactly
  // as picking those same jobs by hand would.
  //
  // `items` is the group's FILTERED contents, so while a search is active the
  // header acts on what is actually visible under it. Selecting "Active" having
  // typed "coil" takes the matching Active jobs, not all 59 — which is the only
  // reading consistent with the header's own count, since that count is filtered
  // too.
  // Thin wrappers over lib/job-select-groups.ts, where the rules live so they
  // can be tested without React. This component keeps only the UI.
  const groupState = (items: JobOpt[]) => groupSelectionState(items, selected);
  const toggleGroup = (items: JobOpt[]) => apply(nextSelectionForGroup(items, selected, jobs));
  const chips = selected.map((id) => jobs.find((j) => j.jobId === id)).filter((j): j is JobOpt => !!j);
  const summary =
    chips.length === 0
      ? "Select jobs…"
      : chips.length === 1
        ? `${chips[0].jobId} — ${chips[0].jobName}`
        : `${chips.length} jobs selected`;

  return (
    <details ref={detailsRef} className="group relative inline-block">
      <summary className="flex w-72 cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-sdc-border bg-white px-3 py-2 text-sm font-medium text-sdc-navy shadow-sm hover:bg-sdc-blue-light">
        <span className="truncate">{summary}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 opacity-70 motion-interactive group-open:rotate-180">
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="motion-menu-panel absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {/* Selected jobs live INSIDE the panel, not beside the closed control:
            the page header lays this out in a tight flex row, and a growing row
            of chips out there would shove the title around as you select. */}
        {chips.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1 border-b border-sdc-border-soft pb-2">
            {chips.map((j) => (
              <span
                key={j.id}
                className="flex max-w-full items-center gap-1 rounded bg-sdc-blue-light px-1.5 py-0.5 text-xs text-sdc-blue-dark"
                title={`${j.jobId} — ${j.jobName}`}
              >
                <span className="truncate font-mono">{j.jobId}</span>
                <button
                  type="button"
                  onClick={() => toggle(j.jobId)}
                  aria-label={`Remove job ${j.jobId}`}
                  className="shrink-0 leading-none opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => apply([])}
              className="ml-auto shrink-0 text-xs font-medium text-sdc-blue hover:underline"
            >
              Clear all
            </button>
          </div>
        )}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search job # or name…"
          className={`${INPUT} mb-2 w-full`}
          autoFocus
        />
        <div className="max-h-80 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-sdc-gray-400">No jobs match.</p>
          ) : (
            groups.map((g) => {
              const open = isOpen(g.name);
              return (
                <div key={g.name}>
                  {/* Group header — TWO sibling controls, not one (2026-08-24).
                      It used to be a single collapse button, with a comment
                      saying clicking a status could never change the selection;
                      the request asks for exactly that, so it now also carries a
                      tri-state checkbox.
                      Siblings rather than nested, because a <button> inside a
                      <button> is invalid HTML and leaves the inner control
                      unreachable by keyboard. Each has its own hit area and its
                      own label. */}
                  <div className="flex w-full items-center gap-1 rounded px-1 py-1 text-xs font-semibold text-sdc-navy hover:bg-sdc-gray-100">
                    {(() => {
                      const state = groupState(g.items);
                      return (
                        <button
                          type="button"
                          role="checkbox"
                          // "mixed" is the ARIA tri-state — the accessible
                          // equivalent of a DOM checkbox's `indeterminate`,
                          // which cannot be set from markup anyway. Kept a
                          // <button> rather than a real <input> so it matches
                          // every other control in this menu.
                          aria-checked={state === "all" ? "true" : state === "some" ? "mixed" : "false"}
                          aria-label={
                            state === "all"
                              ? `Deselect all ${g.items.length} ${g.name} jobs`
                              : `Select all ${g.items.length} ${g.name} jobs`
                          }
                          onClick={() => toggleGroup(g.items)}
                          className="shrink-0 rounded p-0.5 hover:bg-sdc-blue-light"
                        >
                          <span
                            aria-hidden="true"
                            className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-micro font-bold leading-none ${
                              state === "none"
                                ? "border-sdc-border bg-white text-transparent"
                                : "border-sdc-blue bg-sdc-blue text-white"
                            }`}
                          >
                            {/* A dash for "some", a tick for "all" — the two
                                states must be distinguishable at a glance, not
                                just to a screen reader. */}
                            {state === "all" ? "✓" : state === "some" ? "–" : ""}
                          </span>
                        </button>
                      );
                    })()}
                    <button
                      type="button"
                      onClick={() => setOverrides((o) => ({ ...o, [g.name]: !open }))}
                      aria-expanded={open}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                    >
                      <svg
                        viewBox="0 0 16 16"
                        width="9"
                        height="9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.2"
                        className={`shrink-0 opacity-60 motion-interactive ${open ? "rotate-90" : ""}`}
                      >
                        <path d="M6 3.5 L10.5 8 L6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="truncate">{g.name}</span>
                      <span className="ml-auto shrink-0 pl-1 font-normal text-sdc-gray-400">{g.items.length}</span>
                    </button>
                  </div>
                  {open && (
                    // Indented to the group's label, with a hairline rule so a
                    // long expanded group still reads as belonging to its header
                    // once the header has scrolled off.
                    <div className="ml-2 border-l border-sdc-border-soft pl-1">
                      {g.items.map((j) => {
                        const isCurrent = selectedSet.has(j.jobId);
                        return (
                          // A real <button> per row, not a checkbox label: one
                          // click picks and closes, and the row is
                          // keyboard-reachable as one control.
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => toggle(j.jobId)}
                            role="menuitemcheckbox"
                            aria-checked={isCurrent}
                            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-sdc-gray-100 ${
                              isCurrent ? "bg-sdc-blue-light font-medium text-sdc-blue-dark" : ""
                            }`}
                          >
                            {/* Fixed-width check slot so the labels line up
                                whether or not a row is the current one. */}
                            <span className="w-3 shrink-0 text-sdc-blue-dark">{isCurrent ? "✓" : ""}</span>
                            <span className="truncate">
                              <span className="font-mono text-sdc-muted">{j.jobId}</span> — {j.jobName}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </details>
  );
}
