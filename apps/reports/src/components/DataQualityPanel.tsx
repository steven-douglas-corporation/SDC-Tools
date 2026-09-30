"use client";

import { useState } from "react";
import Link from "next/link";
import { card } from "@/components/ui/classnames";
import { SectionTitle } from "@/components/ui/Typography";
import type { DataQuality, PunchExplorer } from "@/lib/data-quality";
import type { RosterQuality } from "@/lib/paylocity-roster-sync";
import type { RosterPerson } from "@/lib/paylocity-roster-parse";
import { DataQualityExplorer } from "@/components/DataQualityExplorer";
import { DataQualityDrill, EmployeeIdDrill } from "@/components/DataQualityDrill";
import { hours as fmtHours } from "@/components/ui/format";

// The Power BI report's "Data Quality" page. Its rules — which punches count as
// invalid, and why — are reproduced in lib/data-quality.ts, where each one is
// traced back to the measure it came from.
//
// Shaped as findings rather than as the report's one big filterable punch table:
// that table is a tool for someone already hunting, and this is the tab a
// manager opens to be told whether there's anything to hunt for. Each check
// states its rule, its size, and the rows behind it.
//
// ── Layout (2026-09-30) ─────────────────────────────────────────────────────
// Three sections — Job punches, Employee roster, Customers — each with its checks
// as a row of tiles. A tile carries the headline (status, count, hours); clicking
// it opens that check's rows in ONE detail panel under the row. Before this every
// check was a full-width card with its table open beneath it, stacked, which made
// the tab a very long page of lists whose counts were rarely on screen together.

const fmtH = (n: number) => `${fmtHours(n)}h`;

// ── Checks: a tile row with one shared detail panel ────────────────

type Check = {
  key: string;
  title: string;
  /** The rule in plain words. A finding nobody can check is a finding nobody acts on. */
  rule: string;
  count: number;
  unit: string;
  hours?: number;
  body: React.ReactNode;
};

// Status is never colour alone: an icon and a word ride with the colour.
function StatusMark({ clean }: { clean: boolean }) {
  return clean ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-sdc-green-bg px-2 py-0.5 text-label font-semibold text-sdc-green-text">
      <svg
        viewBox="0 0 16 16"
        width="10"
        height="10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        aria-hidden="true"
      >
        <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Clean
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-sdc-yellow-bg px-2 py-0.5 text-label font-semibold text-sdc-yellow-text">
      <svg viewBox="0 0 16 16" width="10" height="10" fill="currentColor" aria-hidden="true">
        <path d="M8 1.5l7 13H1l7-13zm-.75 5v4h1.5v-4h-1.5zm0 5.25v1.5h1.5v-1.5h-1.5z" />
      </svg>
      Review
    </span>
  );
}

function CheckTile({ check, selected, onSelect }: { check: Check; selected: boolean; onSelect: () => void }) {
  const clean = check.count === 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      title={check.rule}
      className={`group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-white p-4 text-left motion-interactive hover:shadow-md focus-visible:outline-2 focus-visible:outline-sdc-blue ${
        selected ? "border-sdc-blue ring-2 ring-sdc-blue/30" : "border-sdc-border"
      }`}
    >
      {/* Status strip along the top edge — the tile row reads at a glance. */}
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-1 ${clean ? "bg-sdc-green" : "bg-sdc-yellow"}`} />
      <span className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold leading-snug text-sdc-navy">{check.title}</span>
        <StatusMark clean={clean} />
      </span>
      <span className="mt-auto flex items-baseline gap-1.5 pt-3">
        <span
          className={`font-heading text-3xl font-bold tabular-nums ${clean ? "text-sdc-navy" : "text-sdc-yellow-text"}`}
        >
          {check.count.toLocaleString()}
        </span>
        <span className="text-xs font-medium text-sdc-muted">{check.unit}</span>
      </span>
      <span className="mt-0.5 text-label text-sdc-muted">
        {check.hours && check.hours > 0 ? fmtH(check.hours) : " "}
      </span>
      <span className="mt-2 text-label font-semibold text-sdc-blue group-hover:underline">
        {selected ? "Showing below" : clean ? "Details" : "See the list"}
      </span>
    </button>
  );
}

const GRID_COLS: Record<number, string> = {
  3: "grid-cols-1 sm:grid-cols-3",
  5: "grid-cols-2 sm:grid-cols-3 xl:grid-cols-5",
};

function CheckBoard({
  checks,
  selected,
  onSelect,
}: {
  checks: Check[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  const open = checks.find((c) => c.key === selected) ?? null;
  return (
    <div>
      <div className={`grid gap-3 ${GRID_COLS[checks.length] ?? "grid-cols-2 sm:grid-cols-3"}`}>
        {checks.map((c) => (
          <CheckTile
            key={c.key}
            check={c}
            selected={c.key === selected}
            onSelect={() => onSelect(c.key === selected ? null : c.key)}
          />
        ))}
      </div>
      {open && (
        <div className={`mt-3 ${card("p-5")}`}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">{open.title}</p>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-sdc-muted">{open.rule}</p>
            </div>
            <button
              type="button"
              onClick={() => onSelect(null)}
              className="shrink-0 text-label font-semibold text-sdc-gray-600 hover:text-sdc-navy"
            >
              Close
            </button>
          </div>
          {open.count === 0 ? (
            <p className="mt-3 text-xs font-medium text-sdc-green-text">Nothing to review.</p>
          ) : (
            <div className="mt-3">{open.body}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** The first check with something in it, so the page opens on what needs acting on. */
function firstWithIssues(checks: Check[]): string | null {
  return checks.find((c) => c.count > 0)?.key ?? null;
}

function Section({
  title,
  description,
  badge,
  children,
}: {
  title: string;
  description: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-sdc-border pb-2">
        <div className="min-w-0">
          <SectionTitle>{title}</SectionTitle>
          <p className="mt-0.5 max-w-4xl text-xs leading-relaxed text-sdc-muted">{description}</p>
        </div>
        {badge}
      </div>
      {children}
    </section>
  );
}

function IssueTally({ checks }: { checks: Check[] }) {
  const open = checks.filter((c) => c.count > 0).length;
  return open === 0 ? (
    <StatusMark clean />
  ) : (
    <span className="text-label font-semibold text-sdc-yellow-text">
      {open} of {checks.length} checks need review
    </span>
  );
}

// ── Inconsistent customer names ──────────────────────────────────
//
// The Dashboard's customer chart combines these so it can be read (see
// lib/customer-canonical.ts). That is exactly why the finding has to be here:
// without it, grouping would have turned a visible problem into an invisible
// one, and nobody would ever go and standardize the Customer field.
//
// Each row states the EVIDENCE for its merge, because the merges are not all
// equally solid — an accounting customer account is a fact about the source, a
// reviewed alias is somebody's decision, and a reader comparing totals needs to
// know which one they are looking at.

function CustomerNamingFinding({ data }: { data: DataQuality["customerNaming"] }) {
  const clean = data.groups.length === 0;
  return (
    <div className={`${card("p-5")} ${clean ? "" : "border-sdc-yellow"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">
            Customers stored under more than one name
          </p>
          <p className="mt-1 text-xs leading-relaxed text-sdc-muted">
            One customer typed several ways in the Projects page&apos;s <strong>Customer</strong> field. The
            Dashboard&apos;s &quot;Active Jobs by Customer&quot; chart combines these into one row so it can be read,
            but the source data is still inconsistent — fixing it here is what makes every future report agree without a
            mapping.
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={`font-heading text-2xl font-bold tabular-nums ${clean ? "text-sdc-green-text" : "text-sdc-yellow-text"}`}
          >
            {data.groups.length.toLocaleString()}
          </p>
          <p className="text-label font-semibold text-sdc-gray-400">
            customers
            {data.storedNames > 0 && ` · ${data.storedNames} stored names`}
          </p>
        </div>
      </div>

      {clean ? (
        <p className="mt-3 text-xs font-medium text-sdc-green-text">
          Every customer is stored under a single consistent name.
        </p>
      ) : (
        <div className="mt-3 overflow-x-auto rounded-lg border border-sdc-border">
          <table className="w-full text-left text-xs">
            <thead className="bg-sdc-gray-50 text-label font-semibold uppercase tracking-[0.04em] text-sdc-gray-600">
              <tr>
                <th className="px-3 py-2">Reported as</th>
                <th className="px-3 py-2">Stored names</th>
                <th className="px-3 py-2 text-right">Jobs</th>
                <th className="px-3 py-2">Grouped by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-sdc-border-soft">
              {data.groups.map((g) => (
                <tr key={g.canonicalCustomerId} className="align-top">
                  <td className="px-3 py-2 font-medium text-sdc-navy">{g.canonicalCustomerName}</td>
                  <td className="px-3 py-2">
                    <ul className="space-y-0.5">
                      {g.storedNames.map((n) => (
                        <li key={n.name} className="text-sdc-gray-700">
                          <span className="font-mono text-[0.7rem]">{n.name}</span>
                          <span className="ml-1.5 text-sdc-gray-400">
                            {n.jobCount} job{n.jobCount === 1 ? "" : "s"} · e.g. {n.exampleJobIds.join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-sdc-navy">{g.jobCount}</td>
                  <td className="max-w-[20rem] px-3 py-2 text-sdc-gray-600">{g.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The two caveats a reader needs in order to trust — or challenge — the
          combined totals above. Both are short lists by design: if either grows,
          the mapping is doing work the source data should be doing. */}
      {data.reviewedWithoutSourceEvidence.length > 0 && (
        <div className="mt-3 rounded-lg border border-sdc-border bg-sdc-gray-50 px-3 py-2 text-xs leading-relaxed text-sdc-gray-600">
          <p className="font-semibold text-sdc-navy">Merged by review, not by a source identifier</p>
          <ul className="mt-1 space-y-1">
            {data.reviewedWithoutSourceEvidence.map((r) => (
              <li key={r.canonicalCustomerName}>
                <strong>{r.canonicalCustomerName}</strong> — {r.note}
              </li>
            ))}
          </ul>
        </div>
      )}

      {data.detachedFromAccount.length > 0 && (
        <div className="mt-2 rounded-lg border border-sdc-border bg-sdc-gray-50 px-3 py-2 text-xs leading-relaxed text-sdc-gray-600">
          <p className="font-semibold text-sdc-navy">Deliberately NOT merged into their billing account</p>
          <ul className="mt-1 space-y-1">
            {data.detachedFromAccount.map((d) => (
              <li key={d.companyId}>
                TotalETO company #{d.companyId} — {d.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ── Job punches ───────────────────────────────────────────────────

function PunchesSection({ dq, explorer }: { dq: DataQuality; explorer: PunchExplorer | null }) {
  const checks: Check[] = [
    {
      key: "future",
      title: "Hours logged in the future",
      rule: "Punches dated after Hours Refreshed Thru. Usually a mistyped year or a timesheet entered against the wrong week.",
      count: dq.future.count,
      hours: dq.future.hours,
      unit: "punches",
      body: <DataQualityDrill rows={dq.future.rows} />,
    },
    {
      key: "afterCompletion",
      title: "Hours on a completed job",
      rule: "Punches dated after a job's Complete Date, excluding sections 70, 80 and 90 — warranty and service work after handover is expected, everything else means the job is still absorbing cost after it was closed.",
      count: dq.afterCompletion.count,
      hours: dq.afterCompletion.hours,
      unit: "punches",
      body: <DataQualityDrill rows={dq.afterCompletion.rows} showCompleted />,
    },
    {
      key: "undefinedEmployees",
      title: "Unrecognised employee IDs",
      rule: "Payroll IDs that appear on punches but match nobody on the roster. Their hours still count toward job totals, but nobody can be asked about them — usually a leaver who was never imported, or an ID typed into the wrong field.",
      count: dq.undefinedEmployees.count,
      hours: dq.undefinedEmployees.hours,
      unit: "IDs",
      // Drillable: an unrecognised ID is only actionable once you can see what
      // it has been booking to.
      body: <EmployeeIdDrill ids={dq.undefinedEmployees.ids} />,
    },
  ];
  const [selected, setSelected] = useState<string | null>(() => firstWithIssues(checks));

  return (
    <Section
      title="Job punches"
      badge={<IssueTally checks={checks} />}
      description={
        <>
          The punch checks from the Power BI report&apos;s Data Quality page, run against this app&apos;s own hours
          data. Judged against <strong>Hours Refreshed Thru</strong>
          {dq.refreshedThrough ? (
            <>
              {" "}
              — currently <strong>{dq.refreshedThrough}</strong>
            </>
          ) : (
            " (not yet known — the hours feed has never completed)"
          )}
          , not today&apos;s date, so a punch counts as &quot;future&quot; when it is dated beyond what payroll has
          published.
        </>
      }
    >
      {/* The report's own layout first — cards, slicers, punch table, chart —
          then the checks, which are what you look at when you don't already
          know what you're hunting for. */}
      {explorer && <DataQualityExplorer data={explorer} />}

      <CheckBoard checks={checks} selected={selected} onSelect={setSelected} />

      {/* "Hours booked to a non-job" (the report's "Job Id Not Defined" case) used to
          have its own finding and table here, reading the same HoursImportIssue rows
          the ETC page's own card already showed under a different name. Consolidated
          onto that one location (2026-08-20, by request) rather than left duplicated. */}
      <div className="grid gap-3 md:grid-cols-2">
        <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-xs leading-relaxed text-sdc-gray-600">
          Hours booked to something that isn&apos;t a usable job number (the report&apos;s &quot;Job Id Not
          Defined&quot; case) are tracked on the{" "}
          <Link href="/etc" className="font-semibold text-sdc-blue hover:underline">
            ETC page
          </Link>
          &apos;s <strong>Data Quality — Undefined Hours</strong> card, one month at a time, rather than duplicated
          here.
        </p>
        <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-xs leading-relaxed text-sdc-gray-600">
          <strong>One check from the report is missing.</strong> Its &quot;Section-Function Exception&quot; case flags
          punches on a section-function code marked invalid upstream. This app&apos;s hours import discards punches on
          codes it doesn&apos;t model before they reach the database, so there is no row left here to flag.
        </p>
      </div>

      {dq.truncated && (
        <p className="text-xs text-sdc-gray-400">
          Some lists are capped at 200 rows — the counts are complete, the tables are not.
        </p>
      )}
    </Section>
  );
}

// ── Employee roster (Paylocity) ────────────────────────────────────
//
// Where the Paylocity roster file and the app disagree about people
// (lib/paylocity-roster-parse.ts rosterQualityFindings). The hourly sync adds
// people and mirrors supervisor and title, but deliberately never decides who is
// shown — so the disagreements about that are listed here for a person to act on.

function PeopleTable({ people, note }: { people: RosterPerson[]; note?: (p: RosterPerson) => string | null }) {
  return (
    <div className="max-h-80 overflow-auto rounded-lg border border-sdc-border">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-sdc-gray-50 text-label font-semibold uppercase tracking-[0.04em] text-sdc-gray-600">
          <tr>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2">Paylocity ID</th>
            <th className="px-3 py-2">{note ? "Detail" : "Title"}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sdc-border-soft">
          {people.map((p, i) => (
            <tr key={`${p.paylocityId ?? "none"}-${i}`}>
              <td className="px-3 py-1.5 font-medium text-sdc-navy">{p.name}</td>
              <td className="px-3 py-1.5 font-mono text-[0.7rem] text-sdc-gray-600">{p.paylocityId ?? "—"}</td>
              <td className="px-3 py-1.5 text-sdc-gray-600">{(note ? note(p) : p.title) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// The two kinds of cell in the agreement matrix below.
function AgreeCell({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex flex-col justify-center rounded-lg bg-sdc-green-bg px-3 py-2.5" title={`${n} ${label}`}>
      <span className="font-heading text-xl font-bold tabular-nums text-sdc-navy">{n.toLocaleString()}</span>
      <span className="flex items-center gap-1 text-label font-semibold text-sdc-green-text">
        <svg
          viewBox="0 0 16 16"
          width="9"
          height="9"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden="true"
        >
          <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Agree
      </span>
    </div>
  );
}

function DisagreeCell({ n, label, onOpen }: { n: number; label: string; onOpen: () => void }) {
  return n === 0 ? (
    <div
      className="flex flex-col justify-center rounded-lg border border-dashed border-sdc-border px-3 py-2.5"
      title={`No one ${label}`}
    >
      <span className="font-heading text-xl font-bold tabular-nums text-sdc-gray-400">0</span>
      <span className="text-label font-semibold text-sdc-gray-400">None</span>
    </div>
  ) : (
    <button
      type="button"
      onClick={onOpen}
      title={`${n} ${label} — show the list`}
      className="flex flex-col justify-center rounded-lg bg-sdc-yellow-bg px-3 py-2.5 text-left ring-1 ring-sdc-yellow hover:ring-2 focus-visible:outline-2 focus-visible:outline-sdc-blue"
    >
      <span className="font-heading text-xl font-bold tabular-nums text-sdc-yellow-text">{n.toLocaleString()}</span>
      <span className="text-label font-semibold text-sdc-yellow-text underline-offset-2 hover:underline">Review →</span>
    </button>
  );
}

// Paylocity status × app visibility, for people in both. The diagonal is where the
// two agree; the off-diagonal cells are the two "who is current" checks, and
// clicking one opens it. A matrix rather than a bar because the question is
// "where do they disagree", which is a position, not a proportion.
function AgreementMatrix({
  findings,
  onOpen,
}: {
  findings: NonNullable<RosterQuality["findings"]>;
  onOpen: (key: string) => void;
}) {
  return (
    <div className={card("p-5")}>
      <p className="text-xs font-semibold uppercase tracking-wider text-sdc-gray-600">Who is current?</p>
      <p className="mt-0.5 text-label text-sdc-muted">People in both the Paylocity file and this app.</p>
      <div className="mt-3 grid grid-cols-[auto_1fr_1fr] items-stretch gap-2 text-xs">
        <span />
        <span className="text-center text-label font-semibold uppercase tracking-wide text-sdc-gray-600">
          Shown here
        </span>
        <span className="text-center text-label font-semibold uppercase tracking-wide text-sdc-gray-600">
          Hidden here
        </span>

        <span className="self-center pr-1 text-right text-label font-semibold uppercase tracking-wide text-sdc-gray-600">
          Active in
          <br />
          Paylocity
        </span>
        <AgreeCell n={findings.shownAndActive} label="active in Paylocity and shown here" />
        <DisagreeCell
          n={findings.awaitingShow.length}
          label="active in Paylocity but hidden here"
          onOpen={() => onOpen("awaitingShow")}
        />

        <span className="self-center pr-1 text-right text-label font-semibold uppercase tracking-wide text-sdc-gray-600">
          Inactive in
          <br />
          Paylocity
        </span>
        <DisagreeCell
          n={findings.shownButInactive.length}
          label="inactive in Paylocity but shown here"
          onOpen={() => onOpen("shownButInactive")}
        />
        <AgreeCell n={findings.hiddenAndInactive} label="inactive in Paylocity and hidden here" />
      </div>
    </div>
  );
}

function SyncStatusCard({ roster }: { roster: RosterQuality }) {
  const f = roster.findings;
  const last = roster.lastSuccess ? new Date(roster.lastSuccess).toLocaleString() : null;
  const statusIsProblem = roster.lastStatus != null && /^(Failed|Waiting)/.test(roster.lastStatus);
  const problem = !roster.configured
    ? "not configured"
    : roster.fileError
      ? "file unusable"
      : statusIsProblem
        ? "last pass failed"
        : null;
  return (
    <div className={`${card("p-5")} ${problem ? "border-sdc-yellow" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-sdc-gray-600">Hourly sync</p>
        {problem ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-sdc-yellow-bg px-2 py-0.5 text-label font-semibold text-sdc-yellow-text">
            ! {problem}
          </span>
        ) : (
          <StatusMark clean />
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <p className="font-heading text-2xl font-bold tabular-nums text-sdc-navy">
            {f ? f.fileRows.toLocaleString() : "—"}
          </p>
          <p className="text-label text-sdc-muted">people in the file</p>
        </div>
        <div>
          <p className="text-sm font-semibold text-sdc-navy">{last ?? "Never"}</p>
          <p className="text-label text-sdc-muted">last successful sync</p>
        </div>
      </div>
      {!roster.configured && (
        <p className="mt-3 text-xs text-sdc-yellow-text">
          Set <code>PAYLOCITY_EMPLOYEES_LOCAL_PATH</code> in the server&apos;s .env to the roster file.
        </p>
      )}
      {roster.fileError && <p className="mt-3 text-xs text-sdc-yellow-text">{roster.fileError}</p>}
      {statusIsProblem && !roster.fileError && <p className="mt-3 text-xs text-sdc-yellow-text">{roster.lastStatus}</p>}
      {f?.pending && (
        <p className="mt-3 text-xs text-sdc-gray-600">
          <strong>Not yet synced:</strong> {f.pending}.
        </p>
      )}
    </div>
  );
}

function RosterSection({ roster }: { roster: RosterQuality }) {
  const f = roster.findings;
  const checks: Check[] = f
    ? [
        {
          key: "awaitingShow",
          title: "Active in Paylocity, hidden here",
          rule: "People Paylocity lists as active who are hidden in this app — usually new hires the sync added, waiting for someone to open them on the Employees page and choose Show. Back-office people kept off the roster on purpose also appear here.",
          count: f.awaitingShow.length,
          unit: "people",
          body: <PeopleTable people={f.awaitingShow} />,
        },
        {
          key: "shownButInactive",
          title: "Shown here, inactive in Paylocity",
          rule: "People still shown in this app whom Paylocity lists as inactive — usually someone who has left. The sync never hides anyone, so hide them from their panel on the Employees page if they're gone.",
          count: f.shownButInactive.length,
          unit: "people",
          body: <PeopleTable people={f.shownButInactive} />,
        },
        {
          key: "shownNotInFile",
          title: "Shown here, not in the Paylocity file",
          rule: "People shown in this app with no Paylocity ID, or an ID the roster file doesn't carry — temps, contractors and hand-entered rows. The sync can't keep their supervisor or title current.",
          count: f.shownNotInFile.length,
          unit: "people",
          body: <PeopleTable people={f.shownNotInFile} />,
        },
        {
          key: "ambiguous",
          title: "Names the sync couldn't match",
          rule: "People in the file whose Paylocity ID isn't in this app yet, and whose name matches more than one hand-entered person here. The sync skips them rather than guess — give the right person their Paylocity ID and the next pass links them.",
          count: f.ambiguous.length,
          unit: "people",
          body: (
            <PeopleTable
              people={f.ambiguous.map((a) => ({ name: a.name, paylocityId: a.paylocityId, title: null }))}
              note={(p) =>
                `Could be: ${f.ambiguous.find((a) => a.paylocityId === p.paylocityId)?.candidates.join(", ") ?? "—"}`
              }
            />
          ),
        },
        {
          key: "unresolvedSupervisors",
          title: "Supervisor IDs not found",
          rule: "People whose supervisor in the file is an Employee Id that isn't on the roster. Their current supervisor is left as it is. Usually fixed in Paylocity.",
          count: f.unresolvedSupervisors.length,
          unit: "people",
          body: (
            <PeopleTable
              people={f.unresolvedSupervisors.map((u) => ({ name: u.name, paylocityId: u.paylocityId, title: null }))}
              note={(p) =>
                `Supervisor ID ${f.unresolvedSupervisors.find((u) => u.paylocityId === p.paylocityId)?.supervisorPaylocityId ?? "?"}`
              }
            />
          ),
        },
      ]
    : [];
  const [selected, setSelected] = useState<string | null>(() => firstWithIssues(checks));

  return (
    <Section
      title="Employee roster (Paylocity)"
      badge={checks.length ? <IssueTally checks={checks} /> : undefined}
      description={
        <>
          Every hour the sync adds anyone new from Paylocity&apos;s roster file — hidden until someone chooses Show on
          the Employees page — and keeps supervisors and job titles as Paylocity has them. It never decides who is
          shown, so these checks list where Paylocity and this app disagree about that.
        </>
      }
    >
      <div className={`grid gap-3 ${f ? "lg:grid-cols-[1fr_1.4fr]" : ""}`}>
        <SyncStatusCard roster={roster} />
        {f && <AgreementMatrix findings={f} onOpen={setSelected} />}
      </div>
      {checks.length > 0 && <CheckBoard checks={checks} selected={selected} onSelect={setSelected} />}
    </Section>
  );
}

export function DataQualityPanel({
  dq,
  explorer,
  roster,
}: {
  dq: DataQuality;
  explorer: PunchExplorer | null;
  roster: RosterQuality | null;
}) {
  return (
    <div className="space-y-10">
      <PunchesSection dq={dq} explorer={explorer} />

      {roster && <RosterSection roster={roster} />}

      <Section
        title="Customers"
        description="Customer names as stored on jobs, checked across the whole book — active and completed."
      >
        <CustomerNamingFinding data={dq.customerNaming} />
      </Section>
    </div>
  );
}
