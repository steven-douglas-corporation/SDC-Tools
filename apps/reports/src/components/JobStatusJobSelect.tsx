"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";
import { INPUT } from "@/components/ui/classnames";

// Unified "Job Status, Job" hierarchical filter for the T&M tab — replaces the
// separate JobStatusSelect + JobSelect pair with one control that mirrors the
// Power BI T&M page's own slicer: status groups you can expand/collapse and
// check as a whole, with individual jobs checkable underneath. Everything
// resolves down to one flat ?jobs= job-id list — selecting a whole status
// just expands to every job under it — so an "entire group + a few extra
// jobs from other groups" selection is a plain OR, not an AND between two
// separate dimensions the way the old status+job pair was.
type JobOpt = { id: number; jobId: string; jobName: string; status: string | null };

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

function groupOf(j: JobOpt): string {
  return j.status?.trim() ? j.status : BLANK_GROUP;
}

export function JobStatusJobSelect({ jobs, selected }: { jobs: JobOpt[]; selected: string[] }) {
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

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((j) => j.jobId.includes(q) || j.jobName.toLowerCase().includes(q));
  }, [jobs, query]);

  // Grouped by Job Status, like the Power BI slicer. Built from the FILTERED
  // list so a search narrows the groups too, dropping any group left empty.
  const groups = useMemo(() => {
    const byStatus = new Map<string, JobOpt[]>();
    for (const j of filtered) {
      const key = groupOf(j);
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

  // Full (unfiltered) membership per group — needed to tell "entire group
  // selected" apart from "every currently-searched-down row in it selected".
  const fullGroupMembers = useMemo(() => {
    const byStatus = new Map<string, JobOpt[]>();
    for (const j of jobs) {
      const key = groupOf(j);
      const list = byStatus.get(key);
      if (list) list.push(j);
      else byStatus.set(key, [j]);
    }
    return byStatus;
  }, [jobs]);

  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  function isOpen(name: string): boolean {
    if (name in overrides) return overrides[name];
    if (query.trim()) return true; // open everything while searching
    return name === "Active";
  }

  // Writes the selection to the URL. An EMPTY list still writes `jobs=`
  // rather than deleting the param, so "nothing selected" (→ all jobs) is
  // distinguishable from "no selection made yet" the same way JobSelect does.
  function apply(next: string[]) {
    const currentQs = searchParams.toString();
    const qs = nextParams(currentQs);
    qs.set("jobs", next.join(","));
    qs.delete("statuses"); // drop the legacy separate-status param
    qs.delete("job");
    const q = qs.toString();
    notePendingParams(currentQs, q);
    router.push(`${pathname}?${q}`, { scroll: false });
  }

  function toggleJob(jobId: string) {
    apply(selectedSet.has(jobId) ? selected.filter((s) => s !== jobId) : [...selected, jobId]);
  }

  function toggleGroup(name: string) {
    const members = (fullGroupMembers.get(name) ?? []).map((j) => j.jobId);
    const allSelected = members.length > 0 && members.every((id) => selectedSet.has(id));
    if (allSelected) {
      const drop = new Set(members);
      apply(selected.filter((id) => !drop.has(id)));
    } else {
      const add = new Set(selected);
      for (const id of members) add.add(id);
      apply(jobs.map((j) => j.jobId).filter((id) => add.has(id)));
    }
  }

  function toggleAll() {
    apply(selected.length === jobs.length ? [] : jobs.map((j) => j.jobId));
  }

  const chips = selected.map((id) => jobs.find((j) => j.jobId === id)).filter((j): j is JobOpt => !!j);

  // Closed-control label. Mirrors the Power BI slicer's own summary text:
  // one job → "{status} + {job}", a whole status group → "{status} + N
  // jobs", anything else → a plain count.
  const summary = useMemo(() => {
    if (chips.length === 0) return "All Jobs";
    if (chips.length === jobs.length) return "All Jobs";
    if (chips.length === 1) {
      const j = chips[0];
      return `${groupOf(j)} + ${j.jobId} - ${j.jobName}`;
    }
    const groupsHit = new Set(chips.map(groupOf));
    if (groupsHit.size === 1) {
      const [name] = groupsHit;
      const members = fullGroupMembers.get(name) ?? [];
      if (members.length === chips.length && members.every((j) => selectedSet.has(j.jobId))) {
        return `${name} + ${chips.length} jobs`;
      }
    }
    return `${chips.length} jobs selected`;
  }, [chips, jobs.length, fullGroupMembers, selectedSet]);

  return (
    <details ref={detailsRef} className="group relative inline-block">
      <summary className="flex w-80 cursor-pointer list-none items-center justify-between gap-2 rounded-md border border-sdc-border bg-white px-3 py-2 text-sm font-medium text-sdc-navy shadow-sm hover:bg-sdc-blue-light">
        <span className="truncate">{summary}</span>
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 opacity-70 motion-interactive group-open:rotate-180">
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="motion-menu-panel absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
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
                  onClick={() => toggleJob(j.jobId)}
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
        <button
          type="button"
          onClick={toggleAll}
          role="menuitemcheckbox"
          aria-checked={selected.length === jobs.length}
          className="mb-1 flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm font-semibold text-sdc-navy hover:bg-sdc-gray-100"
        >
          <span className="w-3 shrink-0 text-sdc-blue-dark">{selected.length === jobs.length ? "✓" : ""}</span>
          <span>Select all</span>
        </button>
        <div className="max-h-80 overflow-y-auto">
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-sdc-gray-400">No jobs match.</p>
          ) : (
            groups.map((g) => {
              const open = isOpen(g.name);
              const fullMembers = (fullGroupMembers.get(g.name) ?? []).map((j) => j.jobId);
              const selectedInGroup = fullMembers.filter((id) => selectedSet.has(id)).length;
              const groupChecked = fullMembers.length > 0 && selectedInGroup === fullMembers.length;
              const groupIndeterminate = selectedInGroup > 0 && !groupChecked;
              return (
                <div key={g.name}>
                  <div className="flex w-full items-center gap-1 rounded px-1 py-1 hover:bg-sdc-gray-100">
                    {/* Group checkbox — selects/deselects every job in this status,
                        independent of the expand/collapse chevron next to it. */}
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.name)}
                      role="menuitemcheckbox"
                      aria-checked={groupIndeterminate ? "mixed" : groupChecked}
                      className="flex w-4 shrink-0 items-center justify-center text-sdc-blue-dark"
                      title={groupChecked ? `Deselect all ${g.name} jobs` : `Select all ${g.name} jobs`}
                    >
                      {groupChecked ? "✓" : groupIndeterminate ? "–" : ""}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOverrides((o) => ({ ...o, [g.name]: !open }))}
                      aria-expanded={open}
                      className="flex flex-1 items-center gap-1 text-left text-xs font-semibold text-sdc-navy"
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
                    <div className="ml-2 border-l border-sdc-border-soft pl-1">
                      {g.items.map((j) => {
                        const isCurrent = selectedSet.has(j.jobId);
                        return (
                          <button
                            key={j.id}
                            type="button"
                            onClick={() => toggleJob(j.jobId)}
                            role="menuitemcheckbox"
                            aria-checked={isCurrent}
                            className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-sdc-gray-100 ${
                              isCurrent ? "bg-sdc-blue-light font-medium text-sdc-blue-dark" : ""
                            }`}
                          >
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
