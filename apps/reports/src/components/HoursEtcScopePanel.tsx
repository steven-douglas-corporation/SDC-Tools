import Link from "next/link";
import { card } from "@/components/ui/classnames";
import { hours } from "@/components/ui/format";
import { monthBounds, type EngShop } from "@/lib/hours-etc-scope-rules";
import type { EtcScope } from "@/lib/hours-etc-scope";

// The account that goes with "Match Monthly ETC": this view beside Monthly ETC's
// stored Hours Worked, then every hour the rule left out, grouped by why, each with a
// link to the punches themselves. Server-rendered; the <details> need no client JS.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const TH = "px-3 py-1.5 text-left text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted";
const TD = "border-t border-sdc-border-soft px-3 py-1.5 text-sm text-sdc-navy";
const NUM = "border-t border-sdc-border-soft px-3 py-1.5 text-right font-mono text-sm tabular-nums";

// Differences under half an hour are display rounding, not a discrepancy.
const differs = (a: number, b: number) => Math.abs(a - b) >= 0.5;

function punchesHref(month: string, extra: Record<string, string>): string {
  const b = monthBounds(month);
  const qs = new URLSearchParams({ from: b.from, to: b.to, ...extra });
  return `/hours?${qs.toString()}`;
}

export function HoursEtcScopePanel({ scope }: { scope: EtcScope }) {
  const { report, month } = scope;
  const [y, m] = month.split("-").map(Number);
  const title = `${MONTH_NAMES[m - 1]} ${y}`;
  const leftOutByCode = report.excludedByCode.reduce((s, r) => s + r.hours, 0);
  const leftOutByJob = report.excludedByJob.reduce((s, j) => s + j.hours, 0);
  const anyDiff = (["engineering", "shop", "total"] as const).some((k) => differs(report.view[k], report.etc[k]));

  const rows: { label: string; key: keyof EngShop }[] = [
    { label: "Engineering", key: "engineering" },
    { label: "Shop", key: "shop" },
    { label: "Total", key: "total" },
  ];

  return (
    <div className={card("p-4")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-[0.08em] text-sdc-navy">Matching Monthly ETC &middot; {title}</h2>
        <span className="text-note text-sdc-muted">{scope.monthIsLocked ? "Month submitted — Hours Worked is frozen" : "Month in progress"}</span>
      </div>
      <p className="mt-1 text-note text-sdc-muted">
        Only the jobs the Monthly ETC grid lists for {title}, and only the section codes it has columns for — the same rule Refresh Data
        uses to fill Hours Worked. Everything else is listed below.
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <table className="w-full border-collapse self-start">
          <thead>
            <tr>
              <th className={TH}></th>
              <th className={`${TH} text-right`}>This view</th>
              <th className={`${TH} text-right`}>Monthly ETC</th>
              <th className={`${TH} text-right`}>Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ label, key }) => {
              const d = report.view[key] - report.etc[key];
              return (
                <tr key={key} className={key === "total" ? "font-semibold" : undefined}>
                  <td className={TD}>{label}</td>
                  <td className={`${NUM} text-sdc-navy`}>{hours(report.view[key])}</td>
                  <td className={`${NUM} text-sdc-navy`}>{hours(report.etc[key])}</td>
                  <td className={`${NUM} ${differs(report.view[key], report.etc[key]) ? "text-sdc-red-text" : "text-sdc-muted"}`}>
                    {differs(report.view[key], report.etc[key]) ? `${d > 0 ? "+" : ""}${hours(d)}` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="flex flex-col gap-1.5 text-note text-sdc-gray-600">
          {anyDiff ? (
            <p>
              Monthly ETC stores Hours Worked when its data is refreshed
              {scope.monthIsLocked ? ", and froze it when the month was submitted" : ""}. A difference here is punches added or
              changed since then{scope.monthIsLocked ? "; reopening the month and refreshing would pick them up" : "; Refresh Data on Monthly ETC picks them up"}.
            </p>
          ) : (
            <p>This view and Monthly ETC agree.</p>
          )}
          {scope.caveats.map((c) => (
            <p key={c} className="text-sdc-yellow-text">
              {c}
            </p>
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-sdc-border pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-label font-semibold uppercase tracking-[0.08em] text-sdc-muted">Left out of this view</h3>
          <span className="font-mono text-sm tabular-nums text-sdc-navy">
            {hours(leftOutByCode + leftOutByJob)} of {hours(report.allHours)} h
          </span>
        </div>
        {leftOutByCode + leftOutByJob < 0.5 ? (
          <p className="mt-1 text-note text-sdc-muted">Nothing — every punch here is one Monthly ETC counts.</p>
        ) : (
          <div className="mt-1.5 grid gap-x-6 gap-y-1 md:grid-cols-2">
            <div>
              <p className="text-note font-semibold text-sdc-navy">No Monthly ETC column &middot; {hours(leftOutByCode)} h</p>
              {report.excludedByCode.map((r) => (
                <details key={r.reason} className="group border-b border-sdc-border-soft py-1">
                  <summary className="flex cursor-pointer items-baseline justify-between gap-2 text-sm text-sdc-navy">
                    <span>{r.reason}</span>
                    <span className="font-mono tabular-nums">{hours(r.hours)}</span>
                  </summary>
                  <ul className="mt-1 pl-3 text-note text-sdc-gray-600">
                    {r.codes.map((c) => (
                      <li key={c.code} className="flex justify-between gap-2">
                        <Link href={punchesHref(month, { sections: c.code })} className="hover:underline">
                          <span className="font-mono">{c.code}</span> {c.name}
                        </Link>
                        <span className="font-mono tabular-nums">{hours(c.hours)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
            <div>
              <p className="text-note font-semibold text-sdc-navy">Jobs not on the Monthly ETC grid &middot; {hours(leftOutByJob)} h</p>
              {report.excludedByJob.length === 0 ? (
                <p className="py-1 text-note text-sdc-muted">None.</p>
              ) : (
                <ul className="text-sm text-sdc-navy">
                  {report.excludedByJob.map((j) => (
                    <li key={j.jobId} className="flex justify-between gap-2 border-b border-sdc-border-soft py-1">
                      <Link href={punchesHref(month, { jobs: j.jobId })} className="truncate hover:underline" title={j.jobName}>
                        <span className="font-mono">{j.jobId}</span> {j.jobName}
                      </Link>
                      <span className="font-mono tabular-nums">{hours(j.hours)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-note text-sdc-muted">
                The grid lists Active, billable jobs (for a submitted month, the jobs that were submitted). Hours on these jobs&rsquo; ETC
                codes are not in its totals.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
