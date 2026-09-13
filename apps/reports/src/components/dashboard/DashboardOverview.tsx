import Link from "next/link";
import type { DashboardOverview as Overview } from "@/lib/dashboard-overview";
import { ActiveJobsSection } from "@/components/dashboard/ActiveJobsSection";
import { ExecutionCalendarSection } from "@/components/dashboard/ExecutionCalendar";
import { Band, KpiStrip } from "@/components/dashboard/DashboardLayout";

// ── The Dashboard's Overview panel (2026-08-27 redesign) ────────────────────
//
// Purely presentational: every figure arrives already computed from
// lib/dashboard-overview.ts's single query pass, so there is no business rule in
// this file and no card fetches anything of its own.
//
// The density rule the redesign is about: a section is ONE bordered frame with
// hairline (`gap-px`) dividers between its cells, never N individually bordered,
// shadowed, padded cards — the same trick the KPI strip and the Monthly ETC
// summary strip already use, which is what lets five KPIs, five type rows and a
// FAT list fit in the space four cards used to occupy.

const MONTH_LABEL = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return MONTH_LABEL.format(new Date(Date.UTC(y, m - 1, 1)));
}

function Kpi({
  label,
  value,
  sub,
  href,
  tone = "navy",
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  href?: string;
  tone?: "navy" | "blue" | "yellow" | "muted";
}) {
  const valueClass =
    tone === "blue"
      ? "text-sdc-blue"
      : tone === "yellow"
        ? "text-sdc-yellow-text"
        : tone === "muted"
          ? "text-sdc-gray-400"
          : "text-sdc-navy";
  const body = (
    <div className={`flex h-full flex-col justify-center gap-1 bg-white px-4 py-3 ${href ? "motion-interactive hover:bg-sdc-blue-light/25" : ""}`}>
      <p className="truncate text-label font-semibold uppercase tracking-[0.06em] text-sdc-gray-600">{label}</p>
      <p className={`font-heading text-3xl leading-none font-bold tracking-tight tabular-nums ${valueClass}`}>{value}</p>
      {sub && <p className="truncate text-label leading-tight text-sdc-gray-400">{sub}</p>}
    </div>
  );
  // A flex item that GROWS, not a grid cell — see KpiStrip's own note on why
  // five KPIs in a grid leave a white hole at the middle breakpoints.
  const shell = "min-w-0 flex-1 basis-[11rem]";
  return href ? (
    <Link href={href} className={`${shell} block`}>
      {body}
    </Link>
  ) : (
    <div className={shell}>{body}</div>
  );
}

// The two Scheduler props (`schedulerBaseUrl`, `schedulerJobNumbers`) are gone
// with the FAT list: they existed only to deep-link a FAT row into the
// Scheduler, and the Execution Calendar opens its details in place instead.
export function DashboardOverviewPanel({ data }: { data: Overview }) {
  const label = monthLabel(data.month);
  const eng = data.workforce.find((w) => w.key === "engineering")!;
  const shop = data.workforce.find((w) => w.key === "shop")!;

  // ── What these two cards lead with (2026-08-27) ───────────────────────────
  //
  // The headline is HOURS ACTUALLY BOOKED. It used to be `capacityHours`, and
  // that was the whole of the "Engineering and Shop both say 4,056h" bug:
  // capacity is headcount x a policy figure, Engineering and Shop happen to
  // have 26 people each, and 26 x 156h is 4,056 for both. Nothing was shared or
  // cached between the cards — they were each correctly reporting a number
  // nobody wanted, and the real hours (2,269 and 3,011 for 2026-08) were in the
  // small print underneath.
  //
  // Capacity is still here, as the denominator it always was. A planned figure
  // must never be the number a manager reads as hours worked.
  const capacityYear = data.month.slice(0, 4);

  const hoursValue = (w: (typeof data.workforce)[number]) =>
    w.bookedHours == null ? "—" : `${w.bookedHours.toLocaleString()}h`;

  // Where the number can be traced to its punch rows. The Hours tab has no
  // "month" or "standardDepartment" FILTER param — its `departments` filter is
  // the employee's raw HR department string, a different field that has been
  // confused with standardDepartment here once already (2026-08-17). So this
  // scopes the month with from/to and preselects the Standard Department
  // grouping, which lands on a page whose Engineering and Shop rows are the two
  // figures these cards show.
  const [hoursYear, hoursMonth] = data.month.split("-").map(Number);
  const lastDay = new Date(hoursYear, hoursMonth, 0).getDate();
  const hoursHref =
    `/hours?from=${data.month}-01&to=${data.month}-${String(lastDay).padStart(2, "0")}` +
    `&groupBy=standardDepartment`;

  const hoursSub = (w: (typeof data.workforce)[number]) => {
    const people = `${w.headcount} employees`;
    if (w.bookedHours == null) {
      // No punch rows exist for this month at all. Saying "0 hrs booked" here
      // would be a fake zero — the figure is unknown, not nil.
      return `${people} · ${data.monthInFuture ? "no hours booked yet — future month" : "no hours data for this month"}`;
    }
    // Capacity comes from a published, hand-entered holiday calendar, and only
    // the years actually in workforce-capacity-policy.ts have one. Selecting a
    // month outside those years must say WHY the figure is missing rather than
    // silently dropping the comparison.
    if (w.capacityHours == null || w.capacityHours === 0) {
      return `${people} · no holiday calendar for ${capacityYear} yet`;
    }
    const capacity = `${w.capacityHours.toLocaleString()}h capacity`;
    // A percentage of a month still being worked reads as under-utilisation
    // when it only means the month is half over, so a live month states that
    // instead of computing one.
    if (data.isCurrentMonth) return `${people} · month in progress · ${capacity}`;
    return `${people} · ${Math.round((w.bookedHours / w.capacityHours) * 100)}% of ${capacity}`;
  };

  return (
    <div className="flex flex-col gap-8">
      {/* ── Top KPI strip ─────────────────────────────────────────────────── */}
      <KpiStrip>
        <Kpi
          label="Active Jobs"
          value={String(data.activeTotal)}
          sub={`${data.byType.filter((t) => t.count > 0).length} project types`}
          href="/jobs?status=Active"
          tone="blue"
        />
        <Kpi
          label={`FATs · ${label}`}
          value={data.fats.available ? String(data.fats.monthTotal) : "—"}
          sub={
            data.fats.available
              ? data.fats.monthPreFats > 0
                ? `+ ${data.fats.monthPreFats} pre-FAT${data.fats.monthPreFats === 1 ? "" : "s"}`
                : "pre-FATs excluded"
              : "Scheduler unavailable"
          }
          tone={data.fats.available ? "navy" : "muted"}
        />
        {/* "Hours" in the label, because the number is hours worked and the card
            used to show capacity under the same wording. The link goes to the
            Hours explorer rather than /employees now: that is where this figure
            can be traced to its punch rows, and the headcount in the sub-line
            still reaches the roster from the Employees tab itself. */}
        <Kpi
          label={`Engineering Hours · ${label}`}
          value={hoursValue(eng)}
          sub={hoursSub(eng)}
          href={hoursHref}
        />
        <Kpi
          label={`Shop Hours · ${label}`}
          value={hoursValue(shop)}
          sub={hoursSub(shop)}
          href={hoursHref}
        />
        <Kpi
          label="Head Start Projects"
          value={String(data.headStartTotal)}
          sub="intent to start, no PO yet"
          href="/jobs?status=HeadStart"
          tone={data.headStartTotal > 0 ? "yellow" : "navy"}
        />
      </KpiStrip>

      {/* ── Active jobs: by type, and by customer ─────────────────────────── */}
      {/* A CLIENT component: the charts open an inline drill-through, whose state
          is a hook — and a hook cannot be called from this server component. Only
          that section crosses the boundary; everything else here stays on the
          server. See ActiveJobsSection.tsx. */}
      <Band label="Active work">
        <ActiveJobsSection
          byType={data.byType}
          customers={data.customers}
          activeTotal={data.activeTotal}
          headStartTotal={data.headStartTotal}
        />
      </Band>

      {/* ── Execution Calendar: FATs, Pre-FATs and Customer Visits ────────── */}
      {/* Replaces the old "Execution — FATs" list and the separate
          "Planning — Customer Visits" panel. Both were lists of the same shape
          of thing on one page; the calendar answers "what is happening the week
          of the 14th" without counting rows.
          ── The FAT summary cards are gone too (2026-08-31, by request) ──
          "FATs in <month>", "Pre-FATs", "Involving ME" and "Involving CE" used
          to sit in a column beside the grid, with a paragraph under them about
          placeholder seats and unstaffed FATs. Removed, and the calendar now
          takes the full width of the band rather than 2.2/3 of it — see
          ExecutionCalendarSection, which no longer has a slot to render them
          into. The two counts worth keeping (FATs and pre-FATs this month) were
          already on the top KPI strip and still are; nothing else read the rest,
          so the ME/CE breakdown and the per-FAT rows are gone from
          lib/dashboard-overview.ts as well. */}
      <Band label="Execution &amp; planning">
        <ExecutionCalendarSection data={data.calendar} monthLabel={label} keyDates={data.keyDates} />
      </Band>
    </div>
  );
}