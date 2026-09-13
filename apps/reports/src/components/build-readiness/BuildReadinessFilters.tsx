"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL, BUTTON_COMPACT, INPUT } from "@/components/ui/classnames";
import { MenuStatus, MenuGroup, MenuBulkActions, MenuCheckbox } from "@/components/MenuStatus";
import type { BuildReadinessFilters, JobSnapshotRow, ReadinessBand, RefreshMetaRow } from "@/lib/build-readiness-types";
import {
  listBuildReadinessViews,
  publishBuildReadinessView,
  deleteBuildReadinessSharedView,
  setBuildReadinessTeamDefault,
  deleteBuildReadinessTeamDefault,
  type BuildReadinessViewConfig,
  type BuildReadinessSharedView,
} from "@/lib/build-readiness-views-actions";

const MY_VIEWS_KEY = "build-readiness-my-views";
type MyViews = Record<string, BuildReadinessViewConfig>;

function readMyViews(): MyViews {
  try {
    const raw = window.localStorage.getItem(MY_VIEWS_KEY);
    return raw ? (JSON.parse(raw) as MyViews) : {};
  } catch {
    return {};
  }
}
function writeMyViews(v: MyViews) {
  window.localStorage.setItem(MY_VIEWS_KEY, JSON.stringify(v));
}

const READINESS_OPTIONS: { value: ReadinessBand; label: string }[] = [
  { value: "green", label: "Green — ready" },
  { value: "yellow", label: "Yellow — at risk" },
  { value: "red", label: "Red — blocked" },
  { value: "grey", label: "Grey — no BOM" },
];

function useClickOutside(ref: React.RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current?.open && !ref.current.contains(e.target as Node)) ref.current.open = false;
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [ref]);
}

// ── "Filters ▾" — Customer / Supplier / Readiness in one bucket ─────────────
//
// Replaces three separate toolbar buttons with one, matching ProjectsFilterMenu's
// shape (TOOLBAR_BTN trigger, MenuGroup/MenuCheckbox/MenuBulkActions body). Unlike
// Projects' filters — which default to "everything selected" and narrow as boxes
// are unchecked — these default to EMPTY (no restriction) and only take effect once
// something is ticked, so the trigger's count is "how many groups have a selection",
// not "how many are narrowed below the full set".
//
// No draft/debounce state: this page already re-fetches on every `filters` change via
// BuildReadinessDashboard's own effect, so a tick can call setFilters directly.
type FilterGroupKey = "customers" | "suppliers" | "statuses";

function FilterMenu({
  filters,
  setFilters,
  customers,
  suppliers,
}: {
  filters: BuildReadinessFilters;
  setFilters: (f: BuildReadinessFilters) => void;
  customers: string[];
  suppliers: string[];
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useClickOutside(ref);
  const [query, setQuery] = useState<Partial<Record<FilterGroupKey, string>>>({});

  const groups: { key: FilterGroupKey; label: string; options: string[]; selected: string[]; searchable?: boolean }[] = [
    { key: "customers", label: "Customer", options: customers, selected: filters.customers ?? [], searchable: true },
    { key: "suppliers", label: "Supplier", options: suppliers, selected: filters.suppliers ?? [], searchable: true },
    { key: "statuses", label: "Readiness", options: READINESS_OPTIONS.map((o) => o.value), selected: filters.statuses ?? [] },
  ];
  const activeCount = groups.filter((g) => g.selected.length > 0).length;

  function setGroup(key: FilterGroupKey, values: string[]) {
    setFilters({ ...filters, [key]: values.length ? values : undefined });
  }
  function toggle(key: FilterGroupKey, value: string) {
    const cur = (filters[key] as string[] | undefined) ?? [];
    setGroup(key, cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
  }
  const labelFor = (key: FilterGroupKey, value: string) =>
    key === "statuses" ? (READINESS_OPTIONS.find((o) => o.value === value)?.label ?? value) : value;

  return (
    <details ref={ref} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${activeCount > 0 ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}>
        Filters
        {activeCount > 0 && ` (${activeCount})`}
        <MenuStatus pending={false} />
      </summary>
      <div className="motion-menu-panel styled-scrollbar absolute left-0 top-full z-30 mt-2 max-h-[calc(var(--app-vh)_*_0.7)] w-64 overflow-y-auto rounded-lg border border-sdc-border bg-white p-2 shadow-lg">
        {groups.map((g) => {
          const q = (query[g.key] ?? "").trim().toLowerCase();
          const shown = q ? g.options.filter((o) => labelFor(g.key, o).toLowerCase().includes(q)) : g.options;
          return (
            <MenuGroup key={g.key} label={g.label} count={`${g.selected.length}/${g.options.length}`}>
              {g.searchable && g.options.length > 8 && (
                <input
                  type="search"
                  value={query[g.key] ?? ""}
                  onChange={(e) => setQuery((prev) => ({ ...prev, [g.key]: e.target.value }))}
                  placeholder={`Search ${g.label.toLowerCase()}…`}
                  className={`${INPUT} mb-1 w-full text-xs`}
                />
              )}
              {g.options.length > 0 && <MenuBulkActions onAll={() => setGroup(g.key, [...g.options])} onNone={() => setGroup(g.key, [])} />}
              <div className="max-h-56 overflow-y-auto styled-scrollbar">
                {shown.length === 0 && <p className="px-1.5 py-1 text-xs text-sdc-gray-400">{g.options.length === 0 ? "None available" : "No matches"}</p>}
                {shown.map((opt) => (
                  <MenuCheckbox key={opt} label={labelFor(g.key, opt)} checked={g.selected.includes(opt)} onChange={() => toggle(g.key, opt)} />
                ))}
              </div>
            </MenuGroup>
          );
        })}
      </div>
    </details>
  );
}

function ViewsMenu({
  filters,
  setFilters,
  initialViews,
}: {
  filters: BuildReadinessFilters;
  setFilters: (f: BuildReadinessFilters) => void;
  initialViews: { default: BuildReadinessSharedView | null; shared: BuildReadinessSharedView[] };
}) {
  const { toast } = useToast();
  const ref = useRef<HTMLDetailsElement>(null);
  useClickOutside(ref);
  const [mine, setMine] = useState<MyViews>({});
  const [shared, setShared] = useState<BuildReadinessSharedView[]>(initialViews.shared);
  const [teamDefault, setTeamDefault] = useState<BuildReadinessSharedView | null>(initialViews.default);
  const [busy, setBusy] = useState(false);

  // "My views" only ever live in this browser's localStorage — the server has
  // no way to include them in `initialViews`, so this is the one piece that
  // still needs a mount effect (matching ProjectViewsMenu.tsx's own pattern).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMine(readMyViews());
  }, []);

  const close = () => {
    if (ref.current) ref.current.open = false;
  };

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      const v = await listBuildReadinessViews();
      setShared(v.shared);
      setTeamDefault(v.default);
    } catch (e) {
      toast(e instanceof Error ? e.message : label, "error");
    } finally {
      setBusy(false);
    }
  }

  function handleSaveMine() {
    const name = window.prompt("Name this view — it saves the current filters.");
    if (!name || !name.trim()) return;
    const next = { ...readMyViews(), [name.trim()]: { filters } };
    writeMyViews(next);
    setMine(next);
    toast(`Saved view "${name.trim()}"`);
    close();
  }
  function handleDeleteMine(name: string) {
    const next = { ...readMyViews() };
    delete next[name];
    writeMyViews(next);
    setMine(next);
  }
  function handlePublish(name: string, config: BuildReadinessViewConfig) {
    void run("Couldn't share this view.", async () => {
      await publishBuildReadinessView(name, config);
      handleDeleteMine(name);
      toast(`Shared "${name}" with the team`);
    });
  }

  const myNames = Object.keys(mine).sort((a, b) => a.localeCompare(b));
  const rowBtn = "flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-sdc-gray-100";
  const iconBtn = "shrink-0 rounded px-1.5 text-note text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy";
  const sec = (label: string) => <div className="px-3 pt-2 pb-1 text-label font-semibold uppercase tracking-wider text-sdc-gray-400">{label}</div>;

  return (
    <details ref={ref} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${TOOLBAR_BTN_NEUTRAL}`}>
        Views
        <MenuStatus pending={false} />
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-64 rounded-lg border border-sdc-border bg-white py-1 shadow-lg">
        {teamDefault && (
          <div className="flex items-center gap-1 px-2">
            <button type="button" onClick={() => { setFilters(teamDefault.config.filters); close(); }} className="flex-1 truncate rounded border-y-2 border-sdc-blue-100 px-2 py-1 text-left text-xs font-semibold text-sdc-navy hover:bg-sdc-blue-light">
              Team Default
            </button>
            <button type="button" title="Clear the team default (affects everyone)" className={iconBtn} disabled={busy} onClick={() => run("Couldn't clear the default.", deleteBuildReadinessTeamDefault)}>✕</button>
          </div>
        )}
        {shared.length > 0 && sec("Shared")}
        {shared.map((v) => (
          <div key={v.name} className="flex items-center gap-1 px-2">
            <button type="button" onClick={() => { setFilters(v.config.filters); close(); }} className={rowBtn}>
              {v.name}
              {v.owner ? <span className="text-label text-sdc-gray-400"> · {v.owner}</span> : null}
            </button>
            <button type="button" title="Delete this shared view (affects everyone)" className={iconBtn} disabled={busy} onClick={() => {
              if (window.confirm(`Delete shared view "${v.name}"? This removes it for everyone.`)) run("Couldn't delete the view.", () => deleteBuildReadinessSharedView(v.name));
            }}>✕</button>
          </div>
        ))}
        {sec("My views")}
        {myNames.length ? (
          myNames.map((name) => (
            <div key={name} className="flex items-center gap-1 px-2">
              <button type="button" onClick={() => { setFilters(mine[name].filters); close(); }} className={rowBtn}>{name}</button>
              <button type="button" title="Share this view with everyone" className={iconBtn} disabled={busy} onClick={() => handlePublish(name, mine[name])}>★</button>
              <button type="button" title="Delete this view" className={iconBtn} onClick={() => handleDeleteMine(name)}>✕</button>
            </div>
          ))
        ) : (
          <div className="px-3 pb-1 text-xs text-sdc-gray-400">None yet.</div>
        )}
        <div className="my-1 border-t border-sdc-border-soft" />
        <button type="button" onClick={handleSaveMine} className="block w-full px-3 py-1.5 text-left text-xs font-semibold text-sdc-navy hover:bg-sdc-gray-100">+ Save current as view…</button>
        <button type="button" disabled={busy} onClick={() => run("Couldn't set the default.", async () => { await setBuildReadinessTeamDefault({ filters }); toast("Set as Team Default"); close(); })} className="block w-full px-3 py-1.5 text-left text-xs text-sdc-navy hover:bg-sdc-gray-100">
          Set current as Team Default
        </button>
      </div>
    </details>
  );
}

// ── Compact "Updated … · refresh" cluster, right end of the toolbar ─────────
//
// Replaces the old separate "Live as of … — completed in 6s" card + its own
// "Refresh now" button with one small text+icon cluster in the same toolbar
// row, so the page reads as one bar instead of a toolbar stacked on a status
// card. This is BUILD READINESS'S OWN refresh (triggerBuildReadinessRefresh —
// a live BOM pass scoped to this page), not the app-wide RefreshDataButton,
// which pulls a different set of upstream sources entirely.
function RefreshStatusCluster({ meta, onRefresh }: { meta: RefreshMetaRow; onRefresh: () => void }) {
  const running = meta.status === "running";
  const statusLine = (() => {
    if (running) return `Live — refreshing ${meta.jobsDone} of ${meta.jobsTotal}…`;
    if (!meta.completedAt) return "Not refreshed yet";
    const at = new Date(meta.completedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const secs = meta.durationMs ? Math.round(meta.durationMs / 1000) : null;
    const failedNote = meta.jobsFailed > 0 ? ` (${meta.jobsFailed} project${meta.jobsFailed === 1 ? "" : "s"} failed)` : "";
    return `Updated ${at}${secs != null ? ` · completed in ${secs}s` : ""}${failedNote}`;
  })();

  return (
    <div className="flex items-center gap-2">
      <span className="flex items-center gap-1.5 text-note text-sdc-gray-600">
        {running && <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sdc-blue" aria-hidden />}
        {statusLine}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={running}
        title={running ? "Refreshing…" : "Refresh now — recompute readiness for every active project"}
        className={BUTTON_COMPACT}
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" className={running ? "shrink-0 animate-spin" : "shrink-0"} aria-hidden>
          <path d="M13.5 8 A5.5 5.5 0 1 1 11.6 3.9" strokeLinecap="round" />
          <path d="M13.8 1.8 V4.4 H11.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="sr-only">Refresh now</span>
      </button>
    </div>
  );
}

export function BuildReadinessFilterBar({
  filters,
  setFilters,
  jobs,
  initialViews,
  meta,
  onRefresh,
}: {
  filters: BuildReadinessFilters;
  setFilters: (f: BuildReadinessFilters) => void;
  jobs: JobSnapshotRow[];
  initialViews: { default: BuildReadinessSharedView | null; shared: BuildReadinessSharedView[] };
  meta: RefreshMetaRow;
  onRefresh: () => void;
}) {
  const customers = useMemo(() => [...new Set(jobs.map((j) => j.customer).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b)), [jobs]);
  const suppliers = useMemo(() => {
    const s = new Set<string>();
    for (const j of jobs) for (const v of j.detail.vendors) s.add(v.name);
    return [...s].sort((a, b) => a.localeCompare(b));
  }, [jobs]);

  const anyFilterActive = !!(filters.query || filters.assemblyQuery || filters.customers?.length || filters.suppliers?.length || filters.statuses?.length);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sdc-border bg-white px-3 py-2 shadow-sm">
      <input
        type="search"
        value={filters.query ?? ""}
        onChange={(e) => setFilters({ ...filters, query: e.target.value || undefined })}
        placeholder="Search job # or name…"
        className={`${INPUT} w-48`}
      />
      <input
        type="search"
        value={filters.assemblyQuery ?? ""}
        onChange={(e) => setFilters({ ...filters, assemblyQuery: e.target.value || undefined })}
        placeholder="Search assembly…"
        className={`${INPUT} w-44`}
      />
      <FilterMenu filters={filters} setFilters={setFilters} customers={customers} suppliers={suppliers} />
      <ViewsMenu filters={filters} setFilters={setFilters} initialViews={initialViews} />
      {anyFilterActive && (
        <button type="button" onClick={() => setFilters({})} className={BUTTON_COMPACT}>
          Clear filters
        </button>
      )}
      <div className="ml-auto">
        <RefreshStatusCluster meta={meta} onRefresh={onRefresh} />
      </div>
    </div>
  );
}
