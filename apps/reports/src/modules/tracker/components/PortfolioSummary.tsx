import { CARD_BASE } from "@/components/ui/classnames";
import type { ProjectListItem } from "../service/queries";
import { hours, localToday, portfolioSummary, shortDate } from "./format";

// The project list at a glance: a strip of figures above the table. Every one is added up
// from the rows of that table (./format.ts, portfolioSummary), so the strip can never say
// something the list under it does not.

function Figure({
  label,
  value,
  note,
  warn = false,
}: {
  label: string;
  value: string;
  note: string;
  /** Drawn in red. Never the only signal: the label and the note say what is wrong. */
  warn?: boolean;
}) {
  return (
    <div className={`${CARD_BASE} px-4 py-3`}>
      <dt className="text-xs uppercase tracking-wider text-sdc-gray-600">{label}</dt>
      <dd className={`mt-1 text-2xl font-semibold tabular-nums ${warn ? "text-sdc-red-text" : "text-sdc-navy"}`}>
        {value}
      </dd>
      <dd className="mt-0.5 text-xs text-sdc-gray-600">{note}</dd>
    </div>
  );
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function PortfolioSummary({ projects }: { projects: ProjectListItem[] }) {
  const s = portfolioSummary(projects, localToday());
  if (s.open === 0) return null;

  return (
    <dl aria-label="All projects at a glance" className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <Figure
        label="Active projects"
        value={String(s.active)}
        note={s.open === s.active ? "Every open project is active" : `${s.open - s.active} more planned or on hold`}
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
      />
    </dl>
  );
}
