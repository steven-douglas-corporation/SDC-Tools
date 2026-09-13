import Link from "next/link";
import { SourceStaleBanner } from "@/components/SourceStaleBanner";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { validJobTypeFilter, VALID_JOB_TYPES, compareJobIds } from "@/lib/job-filters";
import { PageTitle } from "@/components/ui/Typography";
import { BUTTON_PRIMARY, PAGE_SHELL, card } from "@/components/ui/classnames";

const STATUS_FILTERS = [
  { key: "all", label: "All", status: undefined },
  { key: "active", label: "Active", status: "Active" },
  { key: "headstart", label: "HeadStart", status: "HeadStart" },
  { key: "completed", label: "Completed", status: "Complete" },
];

export async function JobsView({ params }: { params: { q?: string; status?: string; type?: string; customer?: string } }) {
  const { q, status, type, customer } = params;

  const where: Prisma.JobWhereInput = { ...validJobTypeFilter };
  if (q) {
    where.OR = [
      { jobName: { contains: q } },
      { jobId: { contains: q } },
    ];
  }
  if (status) where.status = status;
  // `type` and `customer` (2026-08-27) exist so the redesigned Dashboard's
  // project-type and customer cards are drillable — clicking "Duplicate · 24"
  // lands on those 24 rows rather than on the unfiltered list. Both are EXACT
  // matches on the stored value, deliberately: the dashboard groups on
  // VALID_JOB_TYPES and on the customer string exactly as stored, so an exact
  // filter here is what makes the drilled row count equal the number clicked.
  // `type` is intersected with, never replaces, validJobTypeFilter's gate.
  if (type && (VALID_JOB_TYPES as readonly string[]).includes(type)) where.type = type;
  if (customer) where.customer = customer;

  const jobs = await prisma.job.findMany({
    where,
    include: { _count: { select: { estimatedHours: true } } },
  });
  jobs.sort((a, b) => compareJobIds(a.jobId, b.jobId)); // numeric, not lexicographic

  const statusLinks = STATUS_FILTERS.map((f) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (f.status) qs.set("status", f.status);
    // A status tab must narrow the current view, not silently drop the type or
    // customer the Dashboard drilled in on.
    if (type) qs.set("type", type);
    if (customer) qs.set("customer", customer);
    const query = qs.toString();
    return {
      key: f.key,
      label: f.label,
      href: `/jobs${query ? `?${query}` : ""}`,
      active: (f.status ?? "") === (status ?? ""),
    };
  });

  return (
    <div className={PAGE_SHELL}>
      <SourceStaleBanner sources={["totaleto_jobs"]} what="This job list" />
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <PageTitle>Jobs</PageTitle>
          <p className="text-sm text-sdc-gray-600">{jobs.length} job{jobs.length === 1 ? "" : "s"}</p>
        </div>
        {/* The old /api/jobs/export CSV link is gone (§24, 2026-08-04). It was seven
            columns, it ignored this page's filters, and — the reason it had to go rather
            than be extended — it had NO authentication check of its own, so the whole
            job list was one unauthenticated URL away. Exporting now lives on the two
            grids people actually work in (Projects, Monthly ETC) behind
            /api/export/<report>, which checks the session and writes an audit row. */}
      </div>

      <div className="mb-5 flex flex-wrap gap-2.5">
        <form className="flex flex-1 gap-2.5">
          <input type="hidden" name="status" value={status ?? ""} />
          <input type="hidden" name="type" value={type ?? ""} />
          <input type="hidden" name="customer" value={customer ?? ""} />
          <div className="flex flex-1 items-center gap-2.5 rounded-lg border border-sdc-border bg-white px-3.5">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-sdc-gray-400">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Search by Job Id or name…"
              className="flex-1 border-none bg-transparent py-2.5 text-sm text-sdc-navy outline-none placeholder:text-sdc-gray-400"
            />
          </div>
          <button type="submit" className={BUTTON_PRIMARY}>
            Search
          </button>
        </form>
        <div className="flex gap-1 rounded-lg bg-sdc-gray-100 p-1">
          {statusLinks.map((f) => (
            <Link
              key={f.key}
              href={f.href}
              className={`motion-interactive rounded-md px-4 py-1.5 text-sm font-semibold whitespace-nowrap ${
                f.active ? "bg-sdc-blue text-white shadow-sm" : "text-sdc-gray-600 hover:text-sdc-navy"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      {/* Arriving here from a Dashboard card, the list is filtered by something
          no control on this page shows. Without this chip the page reads as "we
          only have 24 jobs", which is the wrong conclusion to hand somebody. */}
      {(type || customer) && (
        <div className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="font-semibold text-sdc-gray-600">Filtered by</span>
          {type && (
            <span className="rounded-full bg-sdc-blue-light px-3 py-1 text-label font-semibold text-sdc-blue-dark">Type: {type}</span>
          )}
          {customer && (
            <span className="rounded-full bg-sdc-blue-light px-3 py-1 text-label font-semibold text-sdc-blue-dark">Customer: {customer}</span>
          )}
          <Link
            href={`/jobs${status ? `?status=${encodeURIComponent(status)}` : ""}`}
            className="text-label font-semibold text-sdc-blue underline-offset-2 hover:underline"
          >
            Clear
          </Link>
        </div>
      )}

      <div className={`${card("p-0")} overflow-x-auto`}>
        <div className="grid min-w-[900px] grid-cols-[40px_76px_minmax(240px,1fr)_180px_110px_120px] items-center gap-4 border-b border-sdc-border-soft bg-sdc-gray-50/60 px-6 py-3">
          {["#", "Job Id", "Job Name", "Customer", "Type", "Status"].map((h) => (
            <span key={h} className="text-center text-label font-semibold tracking-wider text-sdc-gray-400 uppercase">
              {h}
            </span>
          ))}
        </div>
        {jobs.length === 0 && <p className="px-6 py-5 text-sm text-sdc-gray-400">No jobs match this filter.</p>}
        <div className="divide-y divide-sdc-border-soft">
          {jobs.map((job, i) => {
            const noUpstreamData = job._count.estimatedHours === 0 && job.totEtoSyncedAt == null;
            return (
            <Link
              key={job.id}
              href={`/jobs/${job.id}`}
              className="motion-interactive grid min-w-[900px] grid-cols-[40px_76px_minmax(240px,1fr)_180px_110px_120px] items-center gap-4 px-6 py-3 text-center text-label hover:bg-sdc-blue-light/40"
            >
              <span className="text-sdc-gray-400 tabular-nums">{i + 1}</span>
              <span className="font-mono text-sdc-muted tabular-nums">{job.jobId}</span>
              <span className="flex min-w-0 items-center justify-center gap-2">
                <span className="truncate font-semibold text-sdc-navy" title={job.jobName}>{job.jobName}</span>
                {noUpstreamData && (
                  <span
                    title="No TotalETO or Power BI data has synced for this job yet — check the Job Id matches upstream, or try syncing again."
                    className="shrink-0 rounded-full bg-sdc-yellow-bg px-2 py-0.5 text-label font-semibold whitespace-nowrap text-sdc-yellow-text"
                  >
                    No PBI/ETO data yet
                  </span>
                )}
              </span>
              <span className="truncate text-sdc-gray-600" title={job.customer ?? undefined}>{job.customer ?? "—"}</span>
              <span className="text-sdc-gray-600">{job.type ?? "—"}</span>
              <span
                className={`flex items-center justify-center gap-1.5 text-label font-semibold ${
                  job.status === "Complete"
                    ? "text-sdc-green-text"
                    : job.status === "HeadStart"
                      ? "text-sdc-yellow-text"
                      : "text-sdc-blue"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    job.status === "Complete" ? "bg-sdc-green" : job.status === "HeadStart" ? "bg-sdc-yellow" : "bg-sdc-blue"
                  }`}
                />
                {job.status}
              </span>
            </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}


// -- Route entry point --
//
// The page's body lives in `JobsView` above so that BOTH this route and the split
// view can render it. Split view renders two views in ONE document (see
// lib/split-view.ts for why one document rather than two frames), which means a
// pane cannot be a route and therefore cannot read `searchParams` - there is only
// one URL, and two panes reading it would collide. So the body takes its context as
// a plain argument, and the two callers differ only in where they read that context
// from: this wrapper reads the URL, a pane reads its own `l.`/`r.` namespace.
//
// Nothing about this route's behaviour changes: same URL, same params, same server
// render. `searchParams` is still awaited HERE, which is what keeps this route
// dynamic exactly as before.
export default async function JobsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; type?: string; customer?: string }> }) {
  return <JobsView params={await searchParams} />;
}
