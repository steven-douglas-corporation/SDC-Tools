"use client";

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

const fmtH = (n: number) => `${fmtHours(n)}h`;

function Finding({
  title,
  rule,
  count,
  hours,
  unit,
  children,
}: {
  title: string;
  rule: string;
  count: number;
  hours: number;
  unit: string;
  children?: React.ReactNode;
}) {
  const clean = count === 0;
  return (
    <div className={`${card("p-5")} ${clean ? "" : "border-sdc-yellow"}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">{title}</p>
          {/* The rule in plain words. A finding nobody can check is a finding
              nobody acts on — and these came from someone else's model, so the
              definition travels with the number. */}
          <p className="mt-1 text-xs leading-relaxed text-sdc-muted">{rule}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`font-heading text-2xl font-bold tabular-nums ${clean ? "text-sdc-green-text" : "text-sdc-yellow-text"}`}>
            {count.toLocaleString()}
          </p>
          <p className="text-label font-semibold text-sdc-gray-400">
            {unit}
            {hours > 0 && ` · ${fmtH(hours)}`}
          </p>
        </div>
      </div>
      {clean ? (
        <p className="mt-3 text-xs font-medium text-sdc-green-text">Nothing to review.</p>
      ) : (
        <div className="mt-3">{children}</div>
      )}
    </div>
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
            One customer typed several ways in the Projects page&apos;s <strong>Customer</strong> field. The Dashboard&apos;s
            &quot;Active Jobs by Customer&quot; chart combines these into one row so it can be read, but the source data is
            still inconsistent — fixing it here is what makes every future report agree without a mapping.
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

// ── Employee roster (Paylocity) ────────────────────────────────────
//
// Where the Paylocity roster file and the app disagree about people
// (lib/paylocity-roster-parse.ts rosterQualityFindings). The hourly sync adds
// people and mirrors supervisor and title, but deliberately never decides who is
// shown — so the disagreements about that are listed here for a person to act on.

function PeopleTable({ people, note }: { people: RosterPerson[]; note?: (p: RosterPerson) => string | null }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border border-sdc-border">
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

function RosterQualitySection({ roster }: { roster: RosterQuality }) {
  const f = roster.findings;
  const last = roster.lastSuccess ? new Date(roster.lastSuccess).toLocaleString() : null;
  const statusIsProblem = roster.lastStatus != null && /^(Failed|Waiting)/.test(roster.lastStatus);
  return (
    <>
      <div className={`${card("p-5")} ${roster.configured && !roster.fileError && !statusIsProblem ? "" : "border-sdc-yellow"}`}>
        <p className="font-heading text-base font-bold tracking-tight text-sdc-navy">Employee roster (Paylocity)</p>
        <p className="mt-1 text-xs leading-relaxed text-sdc-muted">
          Every hour the roster sync adds anyone new from Paylocity&apos;s roster file (hidden until someone chooses Show on
          the Employees page) and keeps supervisors and job titles as Paylocity has them. It never decides who is shown, so
          the checks below list where Paylocity and this app disagree about that.
        </p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="font-semibold text-sdc-gray-600">Last successful sync</dt>
          <dd className="text-sdc-navy">{last ?? "never"}</dd>
          {f && (
            <>
              <dt className="font-semibold text-sdc-gray-600">People in the file</dt>
              <dd className="text-sdc-navy tabular-nums">{f.fileRows.toLocaleString()}</dd>
            </>
          )}
          {statusIsProblem && (
            <>
              <dt className="font-semibold text-sdc-gray-600">Last pass</dt>
              <dd className="text-sdc-yellow-text">{roster.lastStatus}</dd>
            </>
          )}
        </dl>
        {!roster.configured && (
          <p className="mt-3 text-xs font-medium text-sdc-yellow-text">
            Not configured: set <code>PAYLOCITY_EMPLOYEES_LOCAL_PATH</code> in the server&apos;s .env to the roster file.
          </p>
        )}
        {roster.fileError && <p className="mt-3 text-xs font-medium text-sdc-yellow-text">The roster file can&apos;t be used right now: {roster.fileError}</p>}
        {f?.pending && (
          <p className="mt-3 text-xs text-sdc-gray-600">
            <strong>Not yet synced:</strong> the file has changes the next pass will apply — {f.pending}.
          </p>
        )}
      </div>

      {f && (
        <>
          <Finding
            title="Active in Paylocity, hidden here"
            rule="People Paylocity lists as active who are hidden in this app — usually new hires the sync added, waiting for someone to open them on the Employees page and choose Show. Back-office people kept off the roster on purpose will also appear here."
            count={f.awaitingShow.length}
            hours={0}
            unit="people"
          >
            <PeopleTable people={f.awaitingShow} />
          </Finding>

          <Finding
            title="Shown here, inactive in Paylocity"
            rule="People still shown in this app whom Paylocity lists as inactive — usually someone who has left. The sync never hides anyone, so hide them from their panel on the Employees page if they're gone."
            count={f.shownButInactive.length}
            hours={0}
            unit="people"
          >
            <PeopleTable people={f.shownButInactive} />
          </Finding>

          <Finding
            title="Shown here, not in the Paylocity file"
            rule="People shown in this app with no Paylocity ID, or an ID the roster file doesn't carry — temps, contractors and hand-entered rows. The sync can't keep their supervisor or title current."
            count={f.shownNotInFile.length}
            hours={0}
            unit="people"
          >
            <PeopleTable people={f.shownNotInFile} />
          </Finding>

          <Finding
            title="Roster names the sync couldn't match"
            rule="People in the file whose Paylocity ID isn't in this app yet, and whose name matches more than one hand-entered person here. The sync skips them rather than guess — give the right person their Paylocity ID and the next pass links them."
            count={f.ambiguous.length}
            hours={0}
            unit="people"
          >
            <PeopleTable
              people={f.ambiguous.map((a) => ({ name: a.name, paylocityId: a.paylocityId, title: null }))}
              note={(p) => `Could be: ${f.ambiguous.find((a) => a.paylocityId === p.paylocityId)?.candidates.join(", ") ?? "—"}`}
            />
          </Finding>

          <Finding
            title="Supervisor IDs not found"
            rule="People whose supervisor in the file is an Employee Id that isn't on the roster. Their current supervisor is left as it is. Usually fixed in Paylocity."
            count={f.unresolvedSupervisors.length}
            hours={0}
            unit="people"
          >
            <PeopleTable
              people={f.unresolvedSupervisors.map((u) => ({ name: u.name, paylocityId: u.paylocityId, title: null }))}
              note={(p) => `Supervisor ID ${f.unresolvedSupervisors.find((u) => u.paylocityId === p.paylocityId)?.supervisorPaylocityId ?? "?"}`}
            />
          </Finding>
        </>
      )}
    </>
  );
}

export function DataQualityPanel({ dq, explorer, roster }: { dq: DataQuality; explorer: PunchExplorer | null; roster: RosterQuality | null }) {
  return (
    <div className="space-y-5">
      <div className={card("p-5")}>
        <SectionTitle>Data Quality</SectionTitle>
        <p className="mt-1 text-xs leading-relaxed text-sdc-muted">
          The punch checks from the Power BI report&apos;s Data Quality page, run against this app&apos;s own hours data. Everything is
          judged against <strong>Hours Refreshed Thru</strong>
          {dq.refreshedThrough ? (
            <>
              {" "}
              — currently <strong>{dq.refreshedThrough}</strong>
            </>
          ) : (
            " (not yet known — the hours feed has never completed)"
          )}
          , not against today&apos;s date, so a punch counts as &quot;future&quot; when it is dated beyond what payroll has actually published.
        </p>
      </div>

      {/* The report's own layout first — cards, slicers, punch table, chart —
          then the findings, which are what you look at when you don't already
          know what you're hunting for. */}
      {explorer && <DataQualityExplorer data={explorer} />}

      <Finding
        title="Hours logged in the future"
        rule="Punches dated after Hours Refreshed Thru. Usually a mistyped year or a timesheet entered against the wrong week."
        count={dq.future.count}
        hours={dq.future.hours}
        unit="punches"
      >
        <DataQualityDrill rows={dq.future.rows} />
      </Finding>

      <Finding
        title="Hours on a completed job"
        rule="Punches dated after a job's Complete Date, excluding sections 70, 80 and 90 — warranty and service work after handover is expected, everything else means the job is still absorbing cost after it was closed."
        count={dq.afterCompletion.count}
        hours={dq.afterCompletion.hours}
        unit="punches"
      >
        <DataQualityDrill rows={dq.afterCompletion.rows} showCompleted />
      </Finding>

      <Finding
        title="Unrecognised employee IDs"
        rule="Payroll IDs that appear on punches but match nobody on the roster. Their hours still count toward job totals, but nobody can be asked about them — usually a leaver who was never imported, or an ID typed into the wrong field."
        count={dq.undefinedEmployees.count}
        hours={dq.undefinedEmployees.hours}
        unit="IDs"
      >
        {/* Drillable: an unrecognised ID is only actionable once you can see
            what it has been booking to. */}
        <EmployeeIdDrill ids={dq.undefinedEmployees.ids} />
      </Finding>

      {roster && <RosterQualitySection roster={roster} />}

      <CustomerNamingFinding data={dq.customerNaming} />

      {/* "Hours booked to a non-job" (the report's "Job Id Not Defined" case) used to
          have its own finding and table here, reading the same HoursImportIssue rows
          the ETC page's own card already showed under a different name. Consolidated
          onto that one location (2026-08-20, by request) rather than left duplicated. */}
      <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-xs leading-relaxed text-sdc-gray-600">
        Hours booked to something that isn&apos;t a usable job number (the report&apos;s &quot;Job Id Not Defined&quot; case) are
        tracked on the <Link href="/etc" className="font-semibold text-sdc-blue hover:underline">ETC page</Link>&apos;s{" "}
        <strong>Data Quality — Undefined Hours</strong> card, one month at a time, rather than duplicated here.
      </p>

      {dq.truncated && (
        <p className="text-xs text-sdc-gray-400">
          Some lists are capped at 200 rows — the counts above are complete, the tables are not.
        </p>
      )}

      <p className="rounded-lg border border-sdc-border bg-sdc-gray-50 px-4 py-3 text-xs leading-relaxed text-sdc-gray-600">
        <strong>One check from the report is missing.</strong> Its &quot;Section-Function Exception&quot; case flags punches on a
        section-function code marked invalid upstream. This app&apos;s hours import discards punches on codes it doesn&apos;t model
        before they reach the database, so there is no row left here to flag. Making that check possible means keeping those
        discarded punches at import time.
      </p>
    </div>
  );
}
