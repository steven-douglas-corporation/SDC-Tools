"use client";

import { useEffect, useReducer, useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { nextParams, notePendingParams } from "@/lib/url-params";
import { JobStatusJobSelect } from "@/components/JobStatusJobSelect";
import { TmKpiSummary } from "@/components/TmKpiSummary";
import { BuildReadinessDrawer } from "@/components/build-readiness/BuildReadinessDrawer";
import { TmDrillErrorBoundary } from "@/components/TmDrillErrorBoundary";
import { TmHoursDrillPanel } from "@/components/TmHoursDrillPanel";
import { TmPartsDrillPanel } from "@/components/TmPartsDrillPanel";
import { card, INPUT, LABEL } from "@/components/ui/classnames";
import { hours as fmtHours, usd } from "@/components/ui/format";
import type { KpiRowData } from "@/components/ui/KpiRow";
import { sequenced, abandonLane } from "@/lib/request-sequence";
import { loadTmHoursDrill, loadTmPartsDrill } from "@/lib/tm-drill-actions";
import { sumTmHoursDrill, sumTmPartsDrill, reconcileTmDrill } from "@/lib/tm-drill-reconcile";
import { tmDrawerReducer, tmDrawerOpenKey, tmDrawerRowState, type TmDrillKey } from "@/lib/tm-drawer-state";
// Pure, imports nothing — safe in a client bundle, and the SAME validator the
// page and the drill actions use, so all three agree on what a valid date is.
import { isValidCalendarDate } from "@/lib/tm-drill-validate";
// Type-only from tm-report.ts/tm-hours.ts is deliberate — both modules touch
// server-only I/O at load time (tm-report.ts: the Node-only Power BI client;
// tm-hours.ts: `server-only` + Prisma), and a VALUE import here would pull
// that into the browser bundle (this is a "use client" component). `import
// type` is erased at build, so it's always safe.
import type { TmMetrics, TmPartsDrillKey, TmPartsDrillRow } from "@/lib/tm-report";
import type { TmHoursDrillKey, TmHoursDrillRow } from "@/lib/tm-hours";

type JobOpt = { id: number; jobId: string; jobName: string; status: string };
type TmDrillRow = TmHoursDrillRow | TmPartsDrillRow;

const HOURS_DRILL_KEYS: TmHoursDrillKey[] = ["engineeringHours", "shopHours", "pmHours", "manufacturingHours", "otherHours"];

const CARD_TITLE: Record<TmDrillKey, string> = {
  engineeringHours: "Engineering Hours",
  shopHours: "Shop Hours",
  pmHours: "PM Hours",
  manufacturingHours: "Manufacturing Hours",
  otherHours: "Other Hours",
  partInvoicedAmount: "Part Invoiced Amount",
  sdcManufacturedPartsSalesPrice: "SDC Manufactured Parts Sales Price",
  expenseReports: "Expense Reports",
};

const PARTS_AMOUNT: Record<TmPartsDrillKey, { key: "totalPrice" | "invoicedAmount"; label: string }> = {
  partInvoicedAmount: { key: "invoicedAmount", label: "Invoiced $" },
  sdcManufacturedPartsSalesPrice: { key: "totalPrice", label: "Sales Price" },
  expenseReports: { key: "totalPrice", label: "Amount" },
};

function isHoursKey(key: TmDrillKey): key is TmHoursDrillKey {
  return (HOURS_DRILL_KEYS as string[]).includes(key);
}

function jobsLabel(jobs: JobOpt[], selectedJobIds: string[]): string {
  if (selectedJobIds.length === 0 || selectedJobIds.length >= jobs.length) return "All Jobs";
  if (selectedJobIds.length === 1) {
    const j = jobs.find((j) => j.jobId === selectedJobIds[0]);
    return j ? `${j.jobId} - ${j.jobName}` : "1 job";
  }
  return `${selectedJobIds.length} jobs`;
}

function formatDateRange(start: string, end: string): string {
  const parse = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(parse(start))}–${fmt(parse(end))}`;
}

export function TmReportClient({
  jobs,
  selectedJobIds,
  startDate,
  endDate,
  metrics,
  hoursError,
  partsError,
}: {
  jobs: JobOpt[];
  selectedJobIds: string[];
  startDate: string;
  endDate: string;
  metrics: TmMetrics | null;
  /** The four Hours cards' own local-Paylocity read failed — unusual enough to block the whole page, like the old single error did. */
  hoursError: string | null;
  /** Only the three Power BI dollar cards failed — hours still render normally. */
  partsError: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // One state value instead of three (`openDrill`/`drillRows`/`drillError`
  // used to be separate `useState`s — see tm-drawer-state.ts's header for the
  // exact crash that produced, and why a single reducer is the fix rather
  // than a patch). `key` and its data change together, atomically, so there
  // is no render where they can disagree.
  const [drawer, dispatch] = useReducer(tmDrawerReducer<TmDrillRow>, { status: "closed" });
  const openDrill = tmDrawerOpenKey(drawer);
  // Bumped by Retry, so a failed fetch can be re-issued without the effect's
  // other dependencies having changed — same reasoning as EtcMonthKpiCards'
  // own per-lane retry (§37.9: "provide a retry option").
  const [retryNonce, setRetryNonce] = useState(0);
  const [, startTransition] = useTransition();

  const jobIdsKey = selectedJobIds.join(",");

  // Fetched WHEN A ROW'S DETAIL IS OPENED, not with the page — same reasoning
  // as hours-detail-actions.ts's own drills: this is real Power BI network
  // I/O for a panel most sessions never open. Re-fetches automatically if the
  // Job/Status or date filters change while the panel is open, so the drill
  // never shows a stale selection's rows against the current KPI.
  //
  // A drill-through failure must never escape past this effect's own catch —
  // every `run()` (the server action) can reject, and `sequenced()` itself
  // never throws — so nothing here can produce an uncaught rejection or a
  // render-phase throw from bad data reaching this component. The only
  // remaining way a crash could reach the route's error boundary is a genuine
  // RENDER bug in the drawer's own content below, which is why that's wrapped
  // in TmDrillErrorBoundary rather than relied on not to exist.
  useEffect(() => {
    if (!openDrill) return;
    const key = openDrill;
    const requestKey = `${key}::${jobIdsKey}::${startDate}::${endDate}::${retryNonce}`;
    dispatch({ type: "loading", key });
    startTransition(() => {
      (async () => {
        const outcome = isHoursKey(key)
          ? await sequenced("tm-drill", requestKey, () => loadTmHoursDrill(key, selectedJobIds, startDate, endDate))
          : await sequenced("tm-drill", requestKey, () => loadTmPartsDrill(key, selectedJobIds, startDate, endDate));
        if (!outcome.ok) {
          if (outcome.reason === "error") {
            dispatch({ type: "failed", key, message: outcome.error instanceof Error ? outcome.error.message : "Couldn't load this detail." });
          }
          // "stale" means a newer request already owns this lane (the user
          // switched cards, changed filters, or closed the drawer) — nothing
          // to apply, and dispatching anyway would be dead code: the reducer
          // itself would refuse it since `key` no longer matches what's open.
          return;
        }
        dispatch({ type: "resolved", key, rows: outcome.value });

        // ── Reconciliation check (dev/test only, per the task's own ask) ──
        //
        // "KPI Total / Detail Total / Difference", logged every time a drill
        // loads, not just on failure — so a developer testing a filter change
        // sees the invariant hold, not only finds out once it's already
        // broken. Never rendered to end users; console-only, and skipped
        // entirely in production so it costs nothing there.
        if (process.env.NODE_ENV !== "production" && metrics) {
          const kpiTotal = metrics[key];
          const detailTotal = isHoursKey(key)
            ? sumTmHoursDrill(outcome.value as TmHoursDrillRow[])
            : sumTmPartsDrill(outcome.value as TmPartsDrillRow[], PARTS_AMOUNT[key].key);
          const { difference } = reconcileTmDrill(kpiTotal, detailTotal);
          const line = `[tm-reconcile] ${CARD_TITLE[key]} — KPI ${kpiTotal} · Detail ${detailTotal} · Diff ${difference}`;
          if (difference !== 0) console.warn(line);
          else console.info(line);
        }
      })();
    });
    // `jobIdsKey` (a string) stands in for `selectedJobIds` (an array) so this
    // only re-fires on an actual VALUE change, not a new-but-equal array
    // reference from a parent re-render — selectedJobIds itself is read
    // fresh inside the effect either way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDrill, jobIdsKey, startDate, endDate, retryNonce]);

  function toggleDrill(key: TmDrillKey) {
    // Always abandons whatever was in flight for the PREVIOUS card, whether
    // this click is closing it or switching to a different one — a response
    // that lands after either can no longer be applied (request-sequence.ts),
    // and tmDrawerReducer refuses it too even if it somehow arrived anyway.
    abandonLane("tm-drill");
    dispatch({ type: "open", key });
  }

  function retryDrill(key: TmDrillKey) {
    if (openDrill !== key) return;
    setRetryNonce((n) => n + 1);
  }

  // Bumped by the error boundary's own "Try again" — a RENDER crash, not a
  // fetch failure, so there's no `drawer.status === "error"` to gate on the
  // way retryDrill() does; just re-issue the fetch for whatever's still open.
  function retryAfterRenderError() {
    setRetryNonce((n) => n + 1);
  }

  function setDate(key: "start" | "end", value: string) {
    // Navigate only on a COMPLETE, real date. A <input type="date"> fires change
    // with value="" while the field is mid-edit or being cleared, and pushing that
    // put an empty `start`/`end` in the URL, which the server could only read as
    // "not supplied" — so it fell back to the DEFAULT window. Editing one endpoint
    // therefore threw away the other end of the range the user had just set, and
    // the numbers jumped to a period nobody asked for. Ignoring incomplete input
    // leaves the committed range in place until a valid replacement exists.
    if (!isValidCalendarDate(value)) return;
    const currentQs = searchParams.toString();
    const qs = nextParams(currentQs);
    qs.set(key, value);
    const q = qs.toString();
    notePendingParams(currentQs, q);
    router.push(`${pathname}?${q}`, { scroll: false });
  }

  const detailState = tmDrawerRowState(drawer);
  const contextLabel = jobsLabel(jobs, selectedJobIds);
  const metaLine = `${contextLabel} · ${formatDateRange(startDate, endDate)}`;

  // The 7 rows, in the one place that decides what they say — same reasoning
  // as etc-kpi-strip.ts's buildKpiBlocks: the summary renders what it's
  // handed, formatting only. "N jobs" appears only where it says something a
  // reader doesn't already know from the figure (the four Hours rows, split
  // per employee across jobs); the three dollar rows already reconcile to
  // one Power BI amount and gain nothing from repeating the job count beside
  // it — see the task's own example, which leaves them blank too.
  const rows: KpiRowData<TmDrillKey>[] = metrics
    ? [
        ["engineeringHours", fmtHours(metrics.engineeringHours), true],
        ["shopHours", fmtHours(metrics.shopHours), true],
        ["pmHours", fmtHours(metrics.pmHours), true],
        ["manufacturingHours", fmtHours(metrics.manufacturingHours), true],
        // Last of the hours rows, and deliberately present even at zero: it is
        // how the reader can tell the four cards above account for every hour
        // punched in the range. Non-zero means codes outside Engineering / Shop
        // / PM / Manufacturing were charged — Service (80-*), Spare Parts
        // (90-*), or something unmapped worth chasing. Drill it to see which.
        ["otherHours", fmtHours(metrics.otherHours), true],
        ["partInvoicedAmount", usd(metrics.partInvoicedAmount), false],
        ["sdcManufacturedPartsSalesPrice", usd(metrics.sdcManufacturedPartsSalesPrice), false],
        ["expenseReports", usd(metrics.expenseReports), false],
      ].map(([id, value, showJobCount]) => ({
        id: id as TmDrillKey,
        label: CARD_TITLE[id as TmDrillKey],
        value: value as string,
        hint: null,
        tone: null,
        toneLabel: null,
        drill: id as TmDrillKey,
        statusKind: "text" as const,
        statusArrow: "" as const,
        statusText: "",
        statusSign: 0 as const,
        statusTitle: "",
        countLabel: showJobCount ? contextLabel : null,
      }))
    : [];

  return (
    <div className="flex flex-col gap-5">
      {/* Filters — one unified "Job Status, Job" hierarchical picker (matching
          the Power BI T&M page's own slicer) plus the start/end date range.
          Changing either immediately updates all metrics below via a URL
          navigation.

          Labelled "ETC Start Date"/"ETC End Date" until 2026-08-24, which
          implied these picked Monthly ETC months. They do not: the range is
          applied to each metric's own business date — Paylocity workDate for the
          four Hours cards, and the invoice/transaction date behind the Power BI
          measures for the three dollar cards. Only the DEFAULT start is
          ETC-derived (see tm/page.tsx), and a default's provenance is not what a
          filter's label should describe. */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-sdc-gray-600">Job Status, Job</span>
          <JobStatusJobSelect jobs={jobs} selected={selectedJobIds} />
        </div>
        <div className="flex flex-col gap-1">
          <label className={LABEL} htmlFor="tm-start-date">
            Start Date
          </label>
          <input
            id="tm-start-date"
            type="date"
            value={startDate}
            max={endDate}
            onChange={(e) => setDate("start", e.target.value)}
            className={INPUT}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className={LABEL} htmlFor="tm-end-date">
            End Date
          </label>
          <input
            id="tm-end-date"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setDate("end", e.target.value)}
            className={INPUT}
          />
        </div>
      </div>

      {hoursError ? (
        <div className={`${card("p-5")} border-sdc-red-border bg-sdc-red-bg text-sdc-red-text`}>
          Couldn&apos;t load hours data: {hoursError}
        </div>
      ) : (
        <>
          <div className={card("p-5")}>
            <p className="text-xs font-semibold uppercase tracking-wide text-sdc-gray-600">Job</p>
            <p className="mt-1 text-2xl font-bold text-sdc-navy">{metrics?.jobDisplay || "—"}</p>
          </div>

          {partsError && (
            <p className="rounded border border-sdc-yellow bg-sdc-yellow-bg px-2 py-1 text-note text-sdc-yellow-text">
              Couldn&apos;t reach Power BI for Part Invoiced Amount, SDC Manufactured Parts Sales Price, or Expense Reports: {partsError}
            </p>
          )}

          <TmKpiSummary
            title="T&M Summary"
            rows={rows}
            drill={openDrill}
            detailState={detailState}
            onDrill={toggleDrill}
            onRetry={retryDrill}
          />
        </>
      )}

      {/* The drill-through — the SAME right-side drawer shell Job Procurement
          and Build Readiness already share (BuildReadinessDrawer: fixed
          position, backdrop, slide-in from the right, Escape/backdrop-click
          to close), not a T&M-specific overlay. Monthly ETC's own drill
          renders inline beside its KPI card instead — that layout doesn't
          fit T&M (see TmKpiSummary.tsx's note) — so this reuses the other
          existing shared drawer rather than inventing a third pattern. */}
      {openDrill && (
        <BuildReadinessDrawer
          title={`${CARD_TITLE[openDrill]} — Detail`}
          subtitle={metaLine}
          breadcrumb={[CARD_TITLE[openDrill]]}
          onBreadcrumbClick={() => {}}
          onClose={() => toggleDrill(openDrill)}
        >
          {/* Scoped to just the drawer's CONTENT, not its header — see
              TmDrillErrorBoundary.tsx's own header. Close stays reachable
              even if everything below it throws. Remounted on every card
              switch (`key={openDrill}`) so an error caught for one card can
              never still be showing once a different one is open. */}
          <TmDrillErrorBoundary key={openDrill} onRetry={retryAfterRenderError}>
            {isHoursKey(openDrill) ? (
              <TmHoursDrillPanel
                rows={drawer.status === "success" ? (drawer.rows as TmHoursDrillRow[]) : drawer.status === "empty" ? [] : null}
                error={drawer.status === "error" ? drawer.message : null}
                // The same three inputs this drill was fetched with (see the
                // loadTmHoursDrill call above), so the export cannot describe a
                // different selection than the table it sits on. The panel adds
                // its own search box to these at click time.
                exportParams={{ key: openDrill, jobs: selectedJobIds, from: startDate, to: endDate }}
              />
            ) : (
              <TmPartsDrillPanel
                rows={drawer.status === "success" ? (drawer.rows as TmPartsDrillRow[]) : drawer.status === "empty" ? [] : null}
                error={drawer.status === "error" ? drawer.message : null}
                amountKey={PARTS_AMOUNT[openDrill].key}
                amountLabel={PARTS_AMOUNT[openDrill].label}
              />
            )}
          </TmDrillErrorBoundary>
        </BuildReadinessDrawer>
      )}
    </div>
  );
}
