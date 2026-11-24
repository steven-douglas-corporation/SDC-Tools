import Link from "next/link";
import { CARD_BASE } from "@/components/ui/classnames";
import type { Timeline as TimelineData } from "../service/timeline";
import { localToday, shortDate } from "./format";
import type { TimelineScale } from "./Timeline";

// The portfolio as a single milestone line: one time axis, with each project's name stacked above
// or below it and a leader line down to its date. Each project has two dates — planned (its target)
// and forecast (the engine's safe/P80 date, else its forecast finish) — both marked on the axis
// with the slip between them drawn, red when the forecast lands after the plan. The anchor toggle
// chooses which of the two the label hangs from. Same data as the bar view, read as dates.

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const HEAD = 44; // date-header height
const LANE_H = 22; // one row of stacked labels
const LABEL_H = 18;
const AXIS_PAD = 14; // gap between the axis and the nearest label lane
const SCALE_LABEL: Record<TimelineScale, string> = { fit: "Fit", quarter: "Quarters", year: "Years" };

export type DueDateAnchor = "planned" | "forecast";
const ANCHOR_LABEL: Record<DueDateAnchor, string> = { planned: "Planned", forecast: "Forecast" };

function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}

export function DueDateTimeline({
  timeline,
  scale = "fit",
  scaleHref,
  anchor = "planned",
  anchorHref,
  emptyText = "No project has a date to show yet.",
}: {
  timeline: Pick<TimelineData, "rows" | "forecastAsOf">;
  scale?: TimelineScale;
  scaleHref?: (scale: TimelineScale) => string;
  /** Which date a project's label hangs from. */
  anchor?: DueDateAnchor;
  /** Builds the address for an anchor; given, the Planned / Forecast toggle is shown. */
  anchorHref?: (anchor: DueDateAnchor) => string;
  emptyText?: string;
}) {
  type Row = (typeof timeline.rows)[number];
  const projects = timeline.rows
    .filter((r) => !r.isParent)
    .map((r) => ({ r, planned: r.dueDate, forecast: r.p80Finish ?? r.finish }));
  const dated = projects.filter((p) => p.planned || p.forecast);
  const noDate = projects.filter((p) => !p.planned && !p.forecast).map((p) => p.r);

  if (dated.length === 0) {
    return <p className={`${CARD_BASE} p-4 text-sm text-sdc-gray-600`}>{emptyText}</p>;
  }

  const realToday = localToday();
  const today = timeline.forecastAsOf ?? realToday;
  const stale = today !== realToday;
  const todayN = dayNumber(today);
  const nums = [todayN];
  for (const p of dated) {
    if (p.planned) nums.push(dayNumber(p.planned));
    if (p.forecast) nums.push(dayNumber(p.forecast));
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

  // Axis marks, coarser the further out (same rule as the bar timeline).
  const labels: { left: number; label: string }[] = [];
  const ticks: { left: number }[] = [];
  for (let d = first; d <= last; d++) {
    const date = new Date(d * DAY_MS);
    const monthStart = date.getUTCDate() === 1;
    const month = date.getUTCMonth();
    const year = date.getUTCFullYear();
    const atStart = d === first;
    if (scale === "year") {
      if ((monthStart && month === 0) || atStart) labels.push({ left: x(d), label: String(year) });
      if (monthStart && month % 3 === 0) ticks.push({ left: x(d) });
    } else if (scale === "quarter") {
      if ((monthStart && month % 3 === 0) || atStart) labels.push({ left: x(d), label: `Q${Math.floor(month / 3) + 1} ${year}` });
      if (monthStart) ticks.push({ left: x(d) });
    } else {
      if (monthStart || atStart) labels.push({ left: x(d), label: `${MONTHS[month]} ${year}` });
      if (date.getUTCDay() === 1) ticks.push({ left: x(d) });
    }
  }
  if (labels.length > 1 && labels[1]!.left - labels[0]!.left < 64) labels.shift();

  // Lay the labels out in lanes, alternating above and below the axis, packed left to right so two
  // labels never sit on top of each other in the same lane. Text width is estimated (the server
  // cannot measure it), so the packing is approximate.
  const estWidth = (r: Row) => (r.key.length + 1 + r.title.length) * 6.2 + 16;
  const placed = dated
    .map((p) => {
      const anchorDate = anchor === "planned" ? (p.planned ?? p.forecast!) : (p.forecast ?? p.planned!);
      return { ...p, ax: x(dayNumber(anchorDate)) };
    })
    .sort((a, b) => a.ax - b.ax)
    .map((p, i) => ({ p, side: (i % 2 === 0 ? "above" : "below") as "above" | "below", w: estWidth(p.r) }));

  const laneEnds: Record<"above" | "below", number[]> = { above: [], below: [] };
  const withLane = placed.map(({ p, side, w }) => {
    const ends = laneEnds[side];
    let lane = ends.findIndex((end) => end <= p.ax - 6);
    if (lane === -1) {
      lane = ends.length;
      ends.push(0);
    }
    ends[lane] = p.ax + w;
    return { p, side, lane };
  });
  const topLanes = laneEnds.above.length;
  const bottomLanes = laneEnds.below.length;
  const axisY = HEAD + AXIS_PAD + topLanes * LANE_H;
  const height = axisY + AXIS_PAD + bottomLanes * LANE_H + AXIS_PAD;

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

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
        {anchorHref && (
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sdc-gray-600">Hang labels from</span>
            <div className="inline-flex overflow-hidden rounded-md border border-sdc-border">
              {(["planned", "forecast"] as const).map((a) => (
                <Link
                  key={a}
                  href={anchorHref(a)}
                  scroll={false}
                  aria-current={anchor === a ? "true" : undefined}
                  className={`px-2.5 py-1 font-semibold ${
                    anchor === a ? "bg-sdc-blue text-white" : "bg-white text-sdc-navy hover:bg-sdc-gray-100"
                  }`}
                >
                  {ANCHOR_LABEL[a]}
                </Link>
              ))}
            </div>
          </div>
        )}
        {scaleHref && (
          <div className="flex items-center gap-2">
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
      </div>

      <div className={`${CARD_BASE} overflow-x-auto`}>
        <div className="relative" style={{ width: Math.max(width, 480), height }}>
          {/* Date header */}
          <div className="absolute inset-x-0 top-0 border-b border-sdc-border" style={{ height: HEAD }}>
            {labels.map((m) => (
              <span key={m.left} style={{ left: m.left + 4 }} className="absolute top-1 text-xs font-semibold text-sdc-navy">
                {m.label}
              </span>
            ))}
          </div>
          {ticks.map((m) => (
            <div key={m.left} style={{ left: m.left, top: HEAD, bottom: 0 }} className="absolute w-px bg-sdc-border-soft" />
          ))}

          {/* Today */}
          <div style={{ left: x(todayN), top: HEAD - 14, bottom: 0 }} className="absolute w-px bg-sdc-navy" title={`Forecast made for ${shortDate(today)}`}>
            <span className="absolute -top-0.5 left-1 whitespace-nowrap bg-white px-0.5 text-micro font-semibold text-sdc-navy">
              {stale ? `As of ${shortDate(today)}` : "Today"}
            </span>
          </div>

          {/* The axis */}
          <div style={{ left: 0, width, top: axisY }} className="absolute h-px bg-sdc-border" />

          {withLane.map(({ p, side, lane }) => {
            const pn = p.planned ? dayNumber(p.planned) : null;
            const fn = p.forecast ? dayNumber(p.forecast) : null;
            const late = pn != null && fn != null && fn > pn;
            const labelTop = side === "above" ? axisY - AXIS_PAD - (lane + 1) * LANE_H : axisY + AXIS_PAD + lane * LANE_H;
            // The leader runs from the axis to the label's near edge.
            const leaderTop = side === "above" ? labelTop + LABEL_H : axisY;
            const leaderH = side === "above" ? axisY - (labelTop + LABEL_H) : labelTop - axisY;
            const said = [
              `${p.r.key} ${p.r.title}`,
              p.planned ? `planned ${shortDate(p.planned)}` : "no target date",
              p.forecast ? `forecast ${shortDate(p.forecast)}${late ? " (late)" : ""}` : "not forecast",
            ].join(" · ");
            return (
              <div key={p.r.id} title={said}>
                {/* slip on the axis */}
                {pn != null && fn != null && pn !== fn && (
                  <div
                    style={{ left: x(Math.min(pn, fn)), width: Math.abs(x(fn) - x(pn)), top: axisY - 1 }}
                    className={`absolute h-0 border-t-2 border-dashed ${late ? "border-sdc-red" : "border-sdc-gray-400"}`}
                  />
                )}
                {/* planned diamond */}
                {pn != null && (
                  <div style={{ left: x(pn) - 4, top: axisY - 4 }} className="absolute h-2 w-2 rotate-45 border border-sdc-navy bg-white" />
                )}
                {/* forecast dot */}
                {fn != null && (
                  <div style={{ left: x(fn) - 3.5, top: axisY - 3.5 }} className={`absolute h-[7px] w-[7px] rounded-full ${late ? "bg-sdc-red" : "bg-sdc-blue"}`} />
                )}
                {/* leader from the axis up/down to the label */}
                <div style={{ left: p.ax, top: leaderTop, height: Math.max(0, leaderH) }} className="absolute w-px bg-sdc-gray-400" />
                {/* the label */}
                <Link
                  href={`/tracker/${p.r.key}/timeline`}
                  style={{ left: p.ax + 3, top: labelTop }}
                  className="absolute whitespace-nowrap text-xs font-semibold text-sdc-blue hover:underline"
                >
                  {p.r.key} <span className="font-normal text-sdc-navy">{p.r.title}</span>
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
