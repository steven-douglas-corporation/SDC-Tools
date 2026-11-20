import Link from "next/link";
import { CARD_BASE } from "@/components/ui/classnames";
import type { ProjectListItem } from "../service/queries";
import { hours, localToday, portfolioSummary, shortDate, type ListOnly } from "./format";

// The project list at a glance: a strip of figures above the table. Every one is added up
// from the rows of that table (./format.ts, portfolioSummary), so the strip can never say
// something the list under it does not.
//
// A figure that counts projects is also a way to see which ones: choosing it narrows the list
// to them, and choosing it again shows them all. The figures themselves do not change when
// one is chosen, so another can be chosen straight after.

function Figure({
  label,
  value,
  note,
  warn = false,
  href,
  chosen = false,
  hint,
}: {
  label: string;
  value: string;
  note: string;
  /** Drawn in red. Never the only signal: the label and the note say what is wrong. */
  warn?: boolean;
  /** Where choosing the figure leads. Without one it is only a figure. */
  href?: string;
  /** True when the list is narrowed to what this figure counts. */
  chosen?: boolean;
  /** What choosing it does, for the tooltip. */
  hint?: string;
}) {
  const body = (
    <>
      <dt className="text-xs uppercase tracking-wider text-sdc-gray-600">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${warn ? "text-sdc-red-text" : "text-sdc-navy"}`}>
        {value}
      </dd>
      <dd className="mt-0.5 text-xs text-sdc-gray-600">{chosen ? "Showing these. Choose again to show all." : note}</dd>
    </>
  );
  const box = `${CARD_BASE} block px-4 py-3`;
  if (!href) return <div className={box}>{body}</div>;
  return (
    <Link
      href={href}
      scroll={false}
      title={hint}
      aria-current={chosen ? "true" : undefined}
      className={`${box} hover:border-sdc-blue ${chosen ? "border-sdc-blue ring-2 ring-sdc-blue/30" : ""}`}
    >
      {body}
    </Link>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PortfolioSummary({
  projects,
  only,
  hrefFor,
}: {
  /** The projects the figures describe: the list before one of the figures narrows it. */
  projects: ProjectListItem[];
  /** The figure the list is narrowed to, if any. */
  only: ListOnly | null;
  /** The address of the list narrowed to a figure, or to none. */
  hrefFor: (only: ListOnly | null) => string;
}) {
  const s = portfolioSummary(projects, localToday());
  if (s.open === 0) return null;
  // Choosing the chosen one again clears it.
  const pick = (which: ListOnly) => ({ href: hrefFor(only === which ? null : which), chosen: only === which });

  return (
    <dl aria-label="All projects at a glance" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Figure
        label="Active projects"
        value={String(s.active)}
        note={s.open === s.active ? "Every open project is active" : `${s.open - s.active} more planned or on hold`}
        hint="Show only the active projects"
        {...pick("active")}
      />
      <Figure
        label="At risk"
        value={String(s.atRisk)}
        warn={s.atRisk > 0}
        note={
          s.withTarget === 0
            ? "No project has a target date"
            : s.atRisk === 0
              ? `None of ${count(s.withTarget, "project", "projects")} with a target`
              : `Forecast to finish after ${s.atRisk === 1 ? "its" : "their"} target`
        }
        hint="Show only the projects at risk"
        {...pick("at-risk")}
      />
      <Figure label="Hours left" value={hours(s.hoursLeft)} note="Across every open project" />
      <Figure
        label="Cards not forecast"
        value={String(s.notForecast)}
        warn={s.notForecast > 0}
        note={
          s.notForecast === 0
            ? "Every open card has a date"
            : s.noEstimate > 0
              ? `${count(s.noEstimate, "needs", "need")} an estimate`
              : "Each card says why"
        }
        hint="Show only the projects with cards the forecast could not date"
        {...pick("not-forecast")}
      />
      <Figure
        label="Next target"
        value={s.nextTarget ? shortDate(s.nextTarget.date) : "—"}
        warn={s.pastTarget > 0}
        note={
          s.pastTarget > 0
            ? `${count(s.pastTarget, "project is", "projects are")} past target${s.nextTarget ? `; next is ${s.nextTarget.key}` : ""}`
            : s.nextTarget
              ? s.nextTarget.key
              : "No target dates to come"
        }
        href={s.nextTarget ? `/tracker/${s.nextTarget.key}` : undefined}
        hint={s.nextTarget ? `Open ${s.nextTarget.key}` : undefined}
      />
    </dl>
  );
}
