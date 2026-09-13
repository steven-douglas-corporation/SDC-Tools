"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { DrillPanel } from "@/components/ui/Drill";
import { SortableTh } from "@/components/ui/SortableHeader";
import { cycleSortState, sortRows, type SortColumns, type SortState } from "@/lib/table-sort";
import { loadActiveJobDrill } from "@/lib/dashboard-drill-actions";
import { jobTypeColor } from "@/lib/job-type-colors";
import type { JobDrillFilter, JobDrillResult, JobDrillRow } from "@/lib/dashboard-job-drill";

// ── The inline drill-through under the Dashboard's two charts ───────────────
//
// Clicking a bar used to be a <Link> to /jobs?status=Active&customer=… — it left
// the Dashboard, so you lost the chart you were reading and had to come back to
// compare the next customer. The panel opens in place instead, directly under
// the charts, with the charts still on screen above it.
//
// State lives here, in ONE panel shared by both charts, rather than a panel per
// chart: clicking a customer and then a type has to REPLACE what is shown, not
// leave two tables open contradicting each other about what the page is
// currently about.
//
// ── Caching ─────────────────────────────────────────────────────────────────
//
// Results are memoised per filter for the life of the component, so re-opening
// a bar you already looked at is instant and issues no request. Deliberately
// NOT persisted beyond that: the job book changes under you, and a drill served
// from yesterday's cache disagreeing with today's bar is the exact defect this
// whole design is trying to avoid.
//
// A request that is superseded before it lands is dropped rather than rendered —
// clicking three customers quickly must not leave the third bar selected with
// the first customer's rows under it.

type SortKey = "jobId" | "jobName" | "customer" | "rawCustomer" | "type" | "startDate" | "fatDate" | "owners" | "quotedHours" | "actualHours" | "etcHours";

const COLUMNS: SortColumns<JobDrillRow, SortKey> = {
  jobId: { type: "id", value: (r) => r.jobId },
  jobName: { type: "text", value: (r) => r.jobName },
  customer: { type: "text", value: (r) => r.customer },
  rawCustomer: { type: "text", value: (r) => r.rawCustomer },
  type: { type: "text", value: (r) => r.type },
  startDate: { type: "date", value: (r) => r.startDate },
  fatDate: { type: "date", value: (r) => r.fatDate },
  owners: { type: "text", value: (r) => [...r.meOwners, ...r.ceOwners].join(", ") },
  quotedHours: { type: "hours", value: (r) => r.quotedHours },
  actualHours: { type: "hours", value: (r) => r.actualHours },
  etcHours: { type: "hours", value: (r) => r.etcHours },
};

const HEADERS: { key: SortKey; label: string; align?: "right"; width: string }[] = [
  { key: "jobId", label: "Job #", width: "w-[5.5rem]" },
  { key: "jobName", label: "Project Name", width: "min-w-[16rem]" },
  { key: "customer", label: "Customer", width: "min-w-[11rem]" },
  // The stored value, beside the canonical one. Sortable on purpose: sorting a
  // combined customer's rows by this groups the spellings together, which is how
  // you see at a glance which ones need standardizing at source.
  { key: "rawCustomer", label: "Stored As", width: "min-w-[11rem]" },
  { key: "type", label: "Type", width: "w-[6rem]" },
  { key: "startDate", label: "Start", width: "w-[6.5rem]" },
  { key: "fatDate", label: "FAT", width: "w-[6.5rem]" },
  { key: "owners", label: "ME / CE", width: "min-w-[12rem]" },
  { key: "quotedHours", label: "Quoted", align: "right", width: "w-[6rem]" },
  { key: "actualHours", label: "Actual", align: "right", width: "w-[6rem]" },
  { key: "etcHours", label: "ETC", align: "right", width: "w-[6rem]" },
];

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" });
function dateLabel(isoDate: string | null): string {
  if (!isoDate) return "—";
  const [y, m, d] = isoDate.split("-").map(Number);
  return DATE.format(new Date(Date.UTC(y, m - 1, d)));
}
const hrs = (n: number | null): string => (n === null ? "—" : Math.round(n).toLocaleString("en-US"));

export function useJobDrill() {
  const [filter, setFilter] = useState<JobDrillFilter | null>(null);
  const [result, setResult] = useState<JobDrillResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef(new Map<string, JobDrillResult>());
  // Which request is current. A stale response compares unequal and is dropped.
  const latest = useRef(0);

  /**
   * Open the drill for a bar — or close it, if that same bar is already open.
   *
   * The fetch is kicked off HERE, in the event handler, rather than from a
   * useEffect watching `filter`. An effect would have to setState synchronously
   * on both the close path and the cache-hit path, which is the cascading-render
   * pattern the lint rule (and React's own "You Might Not Need an Effect") warns
   * about. Loading a drill is a reaction to a click, not a synchronisation with
   * an external system, so the click is where it belongs.
   */
  const close = useCallback(() => {
    // Bump the ticket so a response still in flight cannot land afterwards and
    // reopen a panel the user just closed.
    latest.current++;
    setFilter(null);
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  /**
   * Open the drill for a bar — or close it, if that same bar is already open.
   *
   * The fetch is kicked off HERE, in the event handler, rather than from a
   * useEffect watching `filter`. An effect would have to setState synchronously
   * on both the close path and the cache-hit path, which is the cascading-render
   * pattern React's "You Might Not Need an Effect" (and this repo's lint rule)
   * warns about. Loading a drill is a reaction to a click, not a synchronisation
   * with an external system, so the click is where it belongs.
   *
   * Note `setFilter` is called with a plain value, never an updater that also
   * fires other setState calls: an updater must be pure, and React invokes it
   * twice under StrictMode, which would have double-fired those side effects.
   */
  const toggle = useCallback(
    (next: JobDrillFilter) => {
      if (filter !== null && filter.kind === next.kind && filter.value === next.value) {
        close();
        return;
      }

      setFilter(next);

      const key = `${next.kind}::${next.value}`;
      const cached = cache.current.get(key);
      if (cached) {
        latest.current++;
        setResult(cached);
        setError(null);
        setLoading(false);
        return;
      }

      const ticket = ++latest.current;
      setLoading(true);
      setError(null);
      // The previous filter's rows are cleared immediately rather than left on
      // screen under the new heading, where they would read as the new bar's data.
      setResult(null);
      loadActiveJobDrill(next)
        .then((r) => {
          if (ticket !== latest.current) return;
          cache.current.set(key, r);
          setResult(r);
        })
        .catch((e: unknown) => {
          if (ticket !== latest.current) return;
          setError(e instanceof Error ? e.message : "Could not load these jobs.");
        })
        .finally(() => {
          if (ticket === latest.current) setLoading(false);
        });
    },
    [filter, close],
  );

  return {
    filter,
    result,
    loading,
    error,
    toggle,
    close,
    isOpen: (f: JobDrillFilter) => filter?.kind === f.kind && filter.value === f.value,
  };
}

export function JobDrillPanel({
  filter,
  result,
  loading,
  error,
  onClose,
  expectedCount,
  label,
}: {
  filter: JobDrillFilter;
  result: JobDrillResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** What the bar said. Rendered beside the row count so a mismatch is visible rather than silent. */
  expectedCount: number;
  /** What to call this bar. `filter.value` is a canonical customer id, not a name. */
  label: string;
}) {
  const [sort, setSort] = useState<SortState<SortKey>>({ key: "jobId", direction: "asc" });
  const rows = result ? sortRows(result.rows, sort, COLUMNS) : [];
  const reconciles = result === null || result.rows.length === expectedCount;
  // How many stored spellings these rows actually carry. Stated in the panel's
  // meta line for a CUSTOMER drill, because "24 jobs" for a customer stored
  // seven different ways is a number somebody will want to check — and the
  // "Stored As" column beside every row is how they check it.
  const storedNames =
    filter.kind === "customer" && result ? new Set(result.rows.map((r) => r.rawCustomer)).size : 1;

  return (
    <DrillPanel
      title={`Active Jobs — ${label}`}
      meta={
        loading
          ? "Loading…"
          : result
            ? `${result.rows.length} job${result.rows.length === 1 ? "" : "s"}${
                reconciles ? "" : ` · chart says ${expectedCount}`
              }${storedNames > 1 ? ` · stored under ${storedNames} customer names` : ""}${
                result.schedulerAvailable ? "" : " · Scheduler unavailable, FAT dates omitted"
              }`
            : undefined
      }
      // Only ever shown when the drill and the bar disagree — which should be
      // impossible (both run ACTIVE_JOB_WHERE), so if it ever appears it is a
      // real defect and needs to be loud rather than quietly wrong.
      note={reconciles ? undefined : "This table and the chart disagree — please report it."}
      onClose={onClose}
      className="mt-3"
    >
      {error ? (
        <p className="px-4 py-6 text-sm text-sdc-red-text">{error}</p>
      ) : loading ? (
        <div className="flex items-center gap-2 px-4 py-6 text-sm text-sdc-muted">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-sdc-border border-t-sdc-blue" aria-hidden />
          Loading jobs…
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-sdc-muted">No active jobs match.</p>
      ) : (
        // The TABLE scrolls sideways, not the Dashboard. DrillPanel already caps
        // the height and scrolls vertically (DRILL_CAP / DRILL_BODY), so this
        // only has to add the horizontal axis.
        <div className="overflow-x-auto">
          <table className="w-full min-w-[70rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-sdc-border bg-white text-xs uppercase tracking-wide text-sdc-muted">
                {HEADERS.map((h) => (
                  <SortableTh
                    key={h.key}
                    label={h.label}
                    sortKey={h.key}
                    type={COLUMNS[h.key].type}
                    sort={sort}
                    onSort={(k) => setSort((s) => cycleSortState(s, k))}
                    className={`${h.width} whitespace-nowrap px-3 py-2 font-semibold`}
                  />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.jobId} className="border-b border-sdc-border-soft hover:bg-sdc-blue-light/25">
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {/* The one link that still leaves the page — and it is a
                        deliberate destination the user asked for by clicking a
                        job number, not a side effect of opening the drill. */}
                    <Link href={`/jobs/${encodeURIComponent(r.jobId)}`} className="font-medium text-sdc-blue hover:underline">
                      {r.jobId}
                    </Link>
                  </td>
                  <td className="max-w-[22rem] truncate px-3 py-1.5 text-sdc-navy" title={r.jobName}>
                    {r.jobName}
                  </td>
                  <td className="max-w-[14rem] truncate px-3 py-1.5 text-sdc-gray-700" title={r.customer}>
                    {r.customer}
                  </td>
                  {/* The customer string as STORED on the job. Rendered muted
                      when it matches the canonical name (the common case, and
                      not something to draw the eye) and in full weight when it
                      differs — those are the rows whose Customer field wants
                      standardizing on the Projects page. Keeping the raw value
                      on screen is what makes a combined bar auditable instead of
                      a number you have to trust. */}
                  <td
                    className={`max-w-[14rem] truncate px-3 py-1.5 ${
                      r.rawCustomer === r.customer ? "text-sdc-gray-400" : "font-medium text-sdc-yellow-text"
                    }`}
                    title={
                      r.rawCustomer === r.customer
                        ? r.rawCustomer
                        : `Stored as "${r.rawCustomer}" — counted under "${r.customer}"`
                    }
                  >
                    {r.rawCustomer}
                  </td>
                  {/* The type's brand colour follows the click into the table — the
                      same jobTypeColor() the bar segments use, so the row you land on
                      is visibly the segment you clicked. A dot rather than a filled
                      pill: two of the five brand colours are very light, and coloured
                      text or a tinted background on them fails contrast, while a solid
                      dot beside full-ink text does not. */}
                  <td className="px-3 py-1.5 whitespace-nowrap text-sdc-gray-700">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-sm ring-1 ring-inset ring-black/10 ${jobTypeColor(r.type).dot}`}
                        aria-hidden
                      />
                      {r.type}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-sdc-gray-700">{dateLabel(r.startDate)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap tabular-nums text-sdc-gray-700">{dateLabel(r.fatDate)}</td>
                  <td
                    className="max-w-[16rem] truncate px-3 py-1.5 text-sdc-gray-700"
                    title={[...r.meOwners, ...r.ceOwners].join(", ") || undefined}
                  >
                    {r.meOwners.length + r.ceOwners.length === 0 ? (
                      <span className="text-sdc-gray-400">—</span>
                    ) : (
                      [...r.meOwners, ...r.ceOwners].join(", ")
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-sdc-gray-700">{hrs(r.quotedHours)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-sdc-gray-700">{hrs(r.actualHours)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-sdc-gray-700">{hrs(r.etcHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </DrillPanel>
  );
}
