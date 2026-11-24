import Link from "next/link";
import { CARD_BASE } from "@/components/ui/classnames";
import type { Timeline as TimelineData } from "../service/timeline";
import { localToday, shortDate } from "./format";
import type { TimelineScale } from "./Timeline";

// The portfolio by completion date: each project's name on the timeline where it is due, with its
// planned date and its forecast date both marked and the gap between them drawn — red when the
// forecast lands after the plan (late). It is the same data as the bar timeline (service/timeline),
// read as two dates per project instead of a bar, so the two views cannot disagree.
//
// Planned = the project's target date (what was committed). Forecast = the engine's prediction, its
// safe (P80) date where there is one, otherwise its forecast finish.

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ROW = 30;
const HEAD = 44;
const SCALE_LABEL: Record<TimelineScale, string> = { fit: "Fit", quarter: "Quarters", year: "Years" };

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

export function DueDateTimeline({
  timeline,
  scale = "fit",
  scaleHref,
  emptyText = "There are no projects with a date to show.",
}: {
  timeline: Pick<TimelineData, "rows" | "forecastAsOf">;
  scale?: TimelineScale;
  scaleHref?: (scale: TimelineScale) => string;
  emptyText?: string;
}) {
  // Only project rows, never a department heading. Planned is the target; forecast is the safe
  // date when there is one, else the forecast finish.
  const dated = timeline.rows
    .filter((r) => !r.isParent)
    .map((r) => ({ r, planned: r.dueDate, forecast: r.p80Finish ?? r.finish }));
  const withDate = dated.filter((d) => d.planned || d.forecast);
  const noDate = dated.filter((d) => !d.planned && !d.forecast);

  if (withDate.length === 0) {
    return <p className={`${CARD_BASE} p-4 text-sm text-sdc-gray-600`}>{emptyText}</p>;
  }

  const realToday = localToday();
  const today = timeline.forecastAsOf ?? realToday;
  const stale = today !== realToday;
  const todayN = dayNumber(today);
  const nums = [todayN];
  for (const d of withDate) {
    if (d.planned) nums.push(dayNumber(d.planned));
    if (d.forecast) nums.push(dayNumber(d.forecast));
  }
  const first = Math.min(...nums) - 10;
  const last = Math.max(...nums) + 10;
  const days = last - first + 1;
  const dayWidth =
    scale === "year"
      ? Math.max(0.7, Math.min(3, 960 / days))
      : scale === "quarter"
        ? Math.max(1.5, Math.min(8, 960 / days))
        : Math.max(4, Math.min(22, Math.floor(960 / days)));
  const width = days * dayWidth;
  const x = (day: number) => (day - first) * dayWidth;

  // Same axis marks as the bar timeline, coarser the further out.
  const labels: { left: number; label: string }[] = [];
  const ticks: { left: number; label: string }[] = [];
  for (let d = first; d <= last; d++) {
    const date = new Date(d * DAY_MS);
    const monthStart = date.getUTCDate() === 1;
    const month = date.getUTCMonth();
    const year = date.getUTCFullYear();
    const atStart = d === first;
    if (scale === "year") {
      if ((monthStart && month === 0) || atStart) labels.push({ left: x(d), label: String(year) });
      if (monthStart && month % 3 === 0) ticks.push({ left: x(d), label: "" });
    } else if (scale === "quarter") {
      if ((monthStart && month % 3 === 0) || atStart) {
        labels.push({ left: x(d), label: `Q${Math.floor(month / 3) + 1} ${year}` });
      }
      if (monthStart) ticks.push({ left: x(d), label: "" });
    } else {
      if (monthStart || atStart) labels.push({ left: x(d), label: `${MONTHS[month]} ${year}` });
      if (date.getUTCDay() === 1) ticks.push({ left: x(d), label: dayWidth >= 8 ? String(date.getUTCDate()) : "" });
    }
  }
  if (labels.length > 1 && labels[1]!.left - labels[0]!.left < 64) labels.shift();

  return (
    <div className="space-y-3">
      <ul aria-label="What the marks mean" className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-sdc-gray-600">
        <li className="flex items-center gap-1.5">
          <span className="h-3 w-3 rotate-45 border border-sdc-navy bg-white" />
          Planned (target)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-sdc-blue" />
          Forecast
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-sdc-red" />
          Forecast, late
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-0 w-6 border-t-2 border-dashed border-sdc-red" />
          Slip (planned → forecast)
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-4 w-px bg-sdc-navy" />
          {stale ? "The day the forecast was made for" : "Today"}
        </li>
      </ul>

      {scaleHref && (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-semibold text-sdc-gray-600">Zoom</span>
          <div className="inline-flex overflow-hidden rounded-md border border-sdc-border">
            {(["fit", "quarter", "year"] as const).map((s) => (
              <Link
                key={s}
                href={scaleHref(s)}
                scroll={false}
                aria-current={scale === s ? "true" : undefined}
                className={`px-2.5 py-1 font-semibold ${
                  scale === s ? "bg-sdc-blue text-white" : "bg-white text-sdc-navy hover:bg-sdc-gray-100"
                }`}
              >
                {SCALE_LABEL[s]}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className={`${CARD_BASE} overflow-x-auto`}>
        <div className="relative" style={{ width: Math.max(width, 480), height: HEAD + withDate.length * ROW }}>
          <div className="absolute inset-x-0 top-0 border-b border-sdc-border" style={{ height: HEAD }}>
            {labels.map((m) => (
              <span key={m.left} style={{ left: m.left + 4 }} className="absolute top-1 text-xs font-semibold text-sdc-navy">
                {m.label}
              </span>
            ))}
            {ticks.map((m) => (
              <span key={m.left} style={{ left: m.left + 2 }} className="absolute bottom-1 text-micro text-sdc-gray-600">
                {m.label}
              </span>
            ))}
          </div>
          {ticks.map((m) => (
            <div key={m.left} style={{ left: m.left, top: HEAD, bottom: 0 }} className="absolute w-px bg-sdc-border-soft" />
          ))}

          <div style={{ left: x(todayN), top: HEAD - 14, bottom: 0 }} className="absolute w-px bg-sdc-navy" title={`Forecast made for ${shortDate(today)}`}>
            <span className="absolute -top-0.5 left-1 whitespace-nowrap bg-white px-0.5 text-micro font-semibold text-sdc-navy">
              {stale ? `As of ${shortDate(today)}` : "Today"}
            </span>
          </div>

          {withDate.map((d, i) => {
            const top = HEAD + i * ROW;
            const p = d.planned ? dayNumber(d.planned) : null;
            const f = d.forecast ? dayNumber(d.forecast) : null;
            const late = p != null && f != null && f > p;
            // The name sits at the planned date when there is one, otherwise at the forecast.
            const anchor = p ?? f!;
            const said = [
              `${d.r.key} ${d.r.title}`,
              d.planned ? `planned ${shortDate(d.planned)}` : "no target date",
              d.forecast ? `forecast ${shortDate(d.forecast)}${late ? " (late)" : ""}` : "not forecast",
            ].join(" · ");
            return (
              <div key={d.r.id} style={{ top, height: ROW }} className="absolute inset-x-0 border-b border-sdc-border-soft" title={said}>
                {/* The slip: a dashed line from the plan to the forecast, red when the forecast is later. */}
                {p != null && f != null && p !== f && (
                  <div
                    style={{ left: x(Math.min(p, f)), width: Math.abs(x(f) - x(p)), top: ROW / 2 - 1 }}
                    className={`absolute h-0 border-t-2 border-dashed ${late ? "border-sdc-red" : "border-sdc-gray-400"}`}
                  />
                )}
                {/* Planned: a hollow navy diamond. */}
                {p != null && (
                  <div
                    style={{ left: x(p) - 5, top: ROW / 2 - 5 }}
                    className="absolute h-2.5 w-2.5 rotate-45 border border-sdc-navy bg-white"
                  />
                )}
                {/* Forecast: a filled dot, red when late. */}
                {f != null && (
                  <div
                    style={{ left: x(f) - 4, top: ROW / 2 - 4 }}
                    className={`absolute h-2 w-2 rounded-full ${late ? "bg-sdc-red" : "bg-sdc-blue"}`}
                  />
                )}
                {/* The project's name, at where it is due. */}
                <Link
                  href={`/tracker/${d.r.key}/timeline`}
                  style={{ left: x(anchor) + 9 }}
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-xs font-semibold text-sdc-blue hover:underline"
                >
                  {d.r.key} <span className="font-normal text-sdc-navy">{d.r.title}</span>
                  {late && <span className="ml-1 font-bold text-sdc-red-text">late</span>}
                </Link>
              </div>
            );
          })}
        </div>
      </div>

      {noDate.length > 0 && (
        <p className="text-xs text-sdc-gray-600">
          {noDate.length} project{noDate.length === 1 ? "" : "s"} ha{noDate.length === 1 ? "s" : "ve"} no target or
          forecast date yet, so {noDate.length === 1 ? "it is" : "they are"} not shown.
        </p>
      )}
    </div>
  );
}
