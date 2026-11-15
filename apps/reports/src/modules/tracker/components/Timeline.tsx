import Link from "next/link";
import { CARD_BASE } from "@/components/ui/classnames";
import type { Timeline as TimelineData, TimelineRow } from "../service/timeline";
import { forecastReason, hours, shortDate } from "./format";

// One project as a timeline: a row per card, grouped under the card it sits under, a bar from
// the forecast's start to its finish, and an arrow for each dependency. Nothing here is typed
// in: every bar is the stored forecast, so this screen and the board always agree.
//
// It is drawn with plain boxes and one SVG layer for the arrows, at fixed sizes, so positions
// can be worked out on the server with no measuring in the browser.

const ROW = 30; // px, height of one row
const HEAD = 44; // px, height of the dates header
const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Days since 1970 for a YYYY-MM-DD date, with no time zone involved. */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y!, m! - 1, d!) / DAY_MS);
}
const isoOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

const BAR_TONE: Record<TimelineRow["category"], string> = {
  todo: "bg-sdc-blue/60",
  in_progress: "bg-sdc-blue",
  blocked: "bg-sdc-red",
  done: "bg-sdc-green",
  cancelled: "bg-sdc-gray-400",
};

const taskHref = (key: string) => {
  const cut = key.lastIndexOf("-");
  return `/tracker/${key.slice(0, cut)}/${key.slice(cut + 1)}`;
};

export function Timeline({ timeline }: { timeline: TimelineData }) {
  const { rows, links, project } = timeline;
  if (rows.length === 0) {
    return <p className={`${CARD_BASE} p-4 text-sm text-sdc-gray-600`}>This project has no cards yet.</p>;
  }

  // ---- the span of days to draw ----
  const today = timeline.forecastAsOf ?? new Date().toISOString().slice(0, 10);
  const todayN = dayNumber(today);
  const dated: number[] = [todayN];
  for (const r of rows) {
    if (r.start) dated.push(dayNumber(r.start));
    if (r.finish) dated.push(dayNumber(r.finish));
    if (r.p80Finish) dated.push(dayNumber(r.p80Finish));
    if (r.dueDate && r.category !== "done") dated.push(dayNumber(r.dueDate));
    // A card finished long ago would stretch the chart for nothing; recent ones are shown.
    if (r.doneOn && dayNumber(r.doneOn) >= todayN - 14) dated.push(dayNumber(r.doneOn));
  }
  if (project.targetDate) dated.push(dayNumber(project.targetDate));
  const first = Math.min(...dated) - 2;
  const last = Math.max(...dated) + 4;
  const days = last - first + 1;
  // Wide enough to read a short plan, narrow enough that a long one still fits a few screens.
  const dayWidth = Math.max(4, Math.min(22, Math.floor(2400 / days)));
  const width = days * dayWidth;
  const x = (day: number) => (day - first) * dayWidth;

  // ---- header marks: a label at each month start, a tick at each Monday ----
  const months: { left: number; label: string }[] = [];
  const mondays: { left: number; label: string }[] = [];
  for (let d = first; d <= last; d++) {
    const date = new Date(d * DAY_MS);
    if (date.getUTCDate() === 1 || d === first) {
      months.push({ left: x(d), label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` });
    }
    if (date.getUTCDay() === 1) mondays.push({ left: x(d), label: String(date.getUTCDate()) });
  }
  // Drop the first label if the next month starts too close for both to fit.
  if (months.length > 1 && months[1]!.left - months[0]!.left < 64) months.shift();

  // ---- where each card's bar is, for the arrows ----
  const index = new Map(rows.map((r, i) => [r.id, i]));
  const box = (r: TimelineRow): { from: number; to: number } | null =>
    r.start && r.finish ? { from: x(dayNumber(r.start)), to: x(dayNumber(r.finish) + 1) } : null;
  const arrows = links.flatMap((l) => {
    const a = rows[index.get(l.fromId) ?? -1];
    const b = rows[index.get(l.toId) ?? -1];
    if (!a || !b) return [];
    const from = box(a);
    const to = box(b);
    if (!from || !to) return [];
    const y1 = index.get(a.id)! * ROW + ROW / 2;
    const y2 = index.get(b.id)! * ROW + ROW / 2;
    const out = from.to + 6;
    const into = to.from - 8;
    // Straight across and down when there is room; otherwise around, between the two rows.
    const path =
      into >= out
        ? `M ${from.to} ${y1} H ${out} V ${y2} H ${to.from - 1}`
        : `M ${from.to} ${y1} H ${out} V ${y2 > y1 ? y2 - ROW / 2 : y2 + ROW / 2} H ${into} V ${y2} H ${to.from - 1}`;
    return [{ key: `${l.fromId}-${l.toId}`, path, label: `${b.key} waits on ${a.key}` }];
  });

  const notDrawn = rows.filter((r) => !r.isParent && r.category !== "done" && !r.finish).length;

  return (
    <div className="space-y-3">
      <div className={`${CARD_BASE} flex overflow-hidden`}>
        {/* The cards, as a fixed column that stays put while the dates scroll. */}
        <div className="w-80 shrink-0 border-r border-sdc-border">
          <div style={{ height: HEAD }} className="border-b border-sdc-border" />
          {rows.map((r) => (
            <div
              key={r.id}
              style={{ height: ROW, paddingLeft: 8 + r.depth * 16 }}
              className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-sdc-border-soft pr-2 text-xs"
            >
              <Link href={taskHref(r.key)} className="font-mono font-semibold text-sdc-blue hover:underline">
                {r.key}
              </Link>
              <span
                title={r.title}
                className={`truncate ${r.isParent ? "font-semibold text-sdc-navy" : "text-sdc-navy"} ${
                  r.category === "done" ? "text-sdc-gray-400 line-through" : ""
                }`}
              >
                {r.title}
              </span>
              {r.uncountedHours != null && (
                <span
                  title={`${hours(r.uncountedHours)} entered on ${r.key} are not counted, because cards sit under it. Open it to clear them.`}
                  className="shrink-0 rounded-full bg-sdc-yellow-bg px-1.5 text-micro font-bold text-sdc-yellow-text"
                >
                  {hours(r.uncountedHours)} not counted
                </span>
              )}
              {r.kindLabel && (
                <span className="rounded-full bg-sdc-gray-100 px-1.5 text-micro font-bold uppercase text-sdc-gray-600">
                  {r.kindLabel}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* The dates. */}
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="relative" style={{ width, height: HEAD + rows.length * ROW }}>
            <div className="absolute inset-x-0 top-0 border-b border-sdc-border" style={{ height: HEAD }}>
              {months.map((m) => (
                <span
                  key={m.left}
                  style={{ left: m.left + 4 }}
                  className="absolute top-1 text-xs font-semibold text-sdc-navy"
                >
                  {m.label}
                </span>
              ))}
              {mondays.map((m) => (
                <span
                  key={m.left}
                  style={{ left: m.left + 2 }}
                  className="absolute bottom-1 text-micro text-sdc-gray-600"
                >
                  {dayWidth >= 8 ? m.label : ""}
                </span>
              ))}
            </div>
            {mondays.map((m) => (
              <div
                key={m.left}
                style={{ left: m.left, top: HEAD, bottom: 0 }}
                className="absolute w-px bg-sdc-border-soft"
              />
            ))}

            {/* Today, and the project's target date. */}
            <div
              style={{ left: x(todayN), top: HEAD - 14, bottom: 0 }}
              className="absolute w-px bg-sdc-navy"
              title={`Forecast made for ${shortDate(today)}`}
            >
              <span className="absolute -top-0.5 left-1 whitespace-nowrap bg-white px-0.5 text-micro font-semibold text-sdc-navy">
                Today
              </span>
            </div>
            {project.targetDate && (
              <div
                style={{ left: x(dayNumber(project.targetDate) + 1), top: HEAD - 14, bottom: 0 }}
                className="absolute w-0 border-l border-dashed border-sdc-red"
                title={`Project target: ${shortDate(project.targetDate)}`}
              >
                <span className="absolute -top-0.5 right-1 whitespace-nowrap bg-white px-0.5 text-micro font-semibold text-sdc-red-text">
                  Target
                </span>
              </div>
            )}

            {rows.map((r, i) => {
              const b = box(r);
              const top = HEAD + i * ROW;
              const late = r.dueDate && r.finish && (r.p80Finish ?? r.finish) > r.dueDate;
              const said = [
                `${r.key} ${r.title}`,
                b ? `${shortDate(r.start)} to ${shortDate(r.finish)}` : null,
                r.p80Finish ? `P80 ${shortDate(r.p80Finish)}` : null,
                r.dueDate ? `due ${shortDate(r.dueDate)}` : null,
                r.isParent ? "spans the cards under it" : r.assigneeName,
                r.statusName,
              ]
                .filter(Boolean)
                .join(" · ");
              return (
                <div
                  key={r.id}
                  style={{ top, height: ROW }}
                  className="absolute inset-x-0 border-b border-sdc-border-soft"
                >
                  {b &&
                    (r.isParent ? (
                      // A parent: a thin bracket over the cards under it.
                      <div
                        title={said}
                        style={{ left: b.from, width: Math.max(4, b.to - b.from), top: ROW / 2 - 4 }}
                        className="absolute h-2 rounded-sm bg-sdc-navy"
                      />
                    ) : r.type === "milestone" ? (
                      <div
                        title={said}
                        style={{ left: b.to - 6, top: ROW / 2 - 6 }}
                        className="absolute h-3 w-3 rotate-45 bg-sdc-navy"
                      />
                    ) : (
                      <>
                        {r.p80Finish && (
                          <div
                            title={`${r.key}: four times in five it is finished by ${shortDate(r.p80Finish)}`}
                            style={{
                              left: b.to,
                              width: x(dayNumber(r.p80Finish) + 1) - b.to,
                              top: ROW / 2 - 7,
                            }}
                            className="absolute h-3.5 rounded-r bg-sdc-blue/20"
                          />
                        )}
                        <div
                          title={said}
                          style={{ left: b.from, width: Math.max(4, b.to - b.from), top: ROW / 2 - 7 }}
                          className={`absolute h-3.5 rounded ${BAR_TONE[r.category]}`}
                        />
                      </>
                    ))}
                  {r.doneOn && dayNumber(r.doneOn) >= first && (
                    <div
                      title={`${r.key} finished ${shortDate(r.doneOn)}`}
                      style={{ left: x(dayNumber(r.doneOn)) + dayWidth / 2 - 5, top: ROW / 2 - 5 }}
                      className="absolute h-2.5 w-2.5 rounded-full bg-sdc-green"
                    />
                  )}
                  {r.dueDate && r.category !== "done" && (
                    <div
                      title={`${r.key} is due ${shortDate(r.dueDate)}${late ? ", and the forecast is later" : ""}`}
                      style={{ left: x(dayNumber(r.dueDate) + 1) - 1, top: 4, bottom: 4 }}
                      className={`absolute w-0.5 ${late ? "bg-sdc-red" : "bg-sdc-gray-600"}`}
                    />
                  )}
                  {!b && !r.isParent && r.category !== "done" && (
                    <span
                      style={{ left: x(todayN) + 6 }}
                      className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-micro italic text-sdc-gray-600"
                    >
                      {forecastReason({
                        driver: null,
                        driverTaskKey: null,
                        priorityFromKey: null,
                        unscheduledReason: r.unscheduledReason,
                        assigneeName: r.assigneeName,
                        expectedUnblockDate: null,
                        forecastFinish: null,
                      })}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Dependencies: from the end of the card that goes first to the start of the one that waits. */}
            <svg
              width={width}
              height={rows.length * ROW}
              style={{ top: HEAD }}
              className="pointer-events-none absolute left-0"
              aria-hidden="true"
            >
              <defs>
                <marker id="tracker-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                  <path d="M0,0 L7,3.5 L0,7 Z" className="fill-sdc-gray-600" />
                </marker>
              </defs>
              {arrows.map((a) => (
                <path
                  key={a.key}
                  d={a.path}
                  fill="none"
                  strokeWidth="1.25"
                  markerEnd="url(#tracker-arrow)"
                  className="stroke-sdc-gray-600"
                >
                  <title>{a.label}</title>
                </path>
              ))}
            </svg>
          </div>
        </div>
      </div>

      <p className="text-xs text-sdc-gray-600">
        Bars are the forecast, from {shortDate(isoOf(first + 2))} on: a card&apos;s start to its finish, with a paler
        tail out to its P80 when a simulation has run. A dark thin bar is a card with cards under it and spans them. An
        arrow runs from a card to the card that waits on it. A green dot is a finished card, a small upright line is a
        due date, and a diamond is a milestone.
        {notDrawn > 0 &&
          ` ${notDrawn} open card${notDrawn === 1 ? " has" : "s have"} no bar because the forecast could not place ${
            notDrawn === 1 ? "it" : "them"
          }; the row says why.`}
      </p>
    </div>
  );
}
