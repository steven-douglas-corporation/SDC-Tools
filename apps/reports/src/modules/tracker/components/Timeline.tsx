import Link from "next/link";
import { CARD_BASE } from "@/components/ui/classnames";
import type { Timeline as TimelineData, TimelineRow } from "../service/timeline";
import { forecastReason, hours, localToday, shortDate } from "./format";

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

const BAR_TONE: Record<TimelineRow["category"], string> = {
  todo: "bg-sdc-blue/60",
  in_progress: "bg-sdc-blue",
  blocked: "bg-sdc-red",
  done: "bg-sdc-green",
  cancelled: "bg-sdc-gray-400",
};

// Blocked is told apart by its stripes as well as its colour, for anyone who cannot rely on red.
const BLOCKED_STRIPES = {
  backgroundImage: "repeating-linear-gradient(135deg, transparent 0 4px, rgba(255,255,255,0.6) 4px 6px)",
} as const;

const taskHref = (key: string) => {
  const cut = key.lastIndexOf("-");
  return `/tracker/${key.slice(0, cut)}/${key.slice(cut + 1)}`;
};

/** One entry in the key above the chart: the mark exactly as it is drawn, and what it means. */
function Mark({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <span className="relative flex h-4 w-7 shrink-0 items-center justify-center">{children}</span>
      {label}
    </li>
  );
}

function Legend({ of, stale, grouped }: { of: "cards" | "projects"; stale: boolean; grouped: boolean }) {
  const cards = of === "cards";
  return (
    <ul aria-label="What the marks mean" className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-sdc-gray-600">
      <Mark label={cards ? "Forecast: start to finish (in progress)" : "Forecast: first start to finish (active)"}>
        <span className="h-3.5 w-full rounded bg-sdc-blue" />
      </Mark>
      <Mark label="Work already done: from when it started">
        <span className="h-3.5 w-full rounded bg-sdc-green/60" />
      </Mark>
      <Mark label={cards ? "Not started yet" : "Not active yet"}>
        <span className="h-3.5 w-full rounded bg-sdc-blue/60" />
      </Mark>
      {cards && (
        <Mark label="Blocked">
          <span className="h-3.5 w-full rounded bg-sdc-red" style={BLOCKED_STRIPES} />
        </Mark>
      )}
      <Mark label="Out to the safe date">
        <span className="h-3.5 w-full rounded-r bg-sdc-blue/20" />
      </Mark>
      {cards && (
        <Mark label="Has cards under it; spans them">
          <span className="h-2 w-full rounded-sm bg-sdc-navy" />
        </Mark>
      )}
      {!cards && grouped && (
        <Mark label="A department; spans its projects">
          <span className="h-2 w-full rounded-sm bg-sdc-navy" />
        </Mark>
      )}
      {cards && (
        <Mark label="Milestone">
          <span className="h-3 w-3 rotate-45 bg-sdc-navy" />
        </Mark>
      )}
      {cards && (
        <Mark label="Finished">
          <span className="h-2.5 w-2.5 rounded-full bg-sdc-green" />
        </Mark>
      )}
      {/* One entry for the date; red, with its mark, is the same date when the work will be late. */}
      <Mark label={`${cards ? "Due date" : "Target date"} (red when the work will finish late)`}>
        <span className="h-4 w-1.5 border-y-2 border-r-2 border-sdc-gray-600" />
        <span className="ml-1.5 h-4 w-1.5 border-y-2 border-r-2 border-sdc-red" />
        <span className="ml-0.5 text-xs font-bold leading-none text-sdc-red-text">!</span>
      </Mark>
      <Mark
        label={cards ? "Waits on (arrow points at the card that waits)" : "Has a card waiting on the other project"}
      >
        <svg width="28" height="16" aria-hidden="true">
          <path d="M2 4 H12 V12 H24" fill="none" strokeWidth="1.25" className="stroke-sdc-gray-600" />
          <path d="M20 9 L26 12 L20 15 Z" className="fill-sdc-gray-600" />
        </svg>
      </Mark>
      <Mark label={stale ? "The day the forecast was made for" : "Today"}>
        <span className="h-4 w-px bg-sdc-navy" />
      </Mark>
      {cards && (
        <Mark label="Project target">
          <span className="h-4 w-0 border-l border-dashed border-sdc-red" />
        </Mark>
      )}
    </ul>
  );
}

export function Timeline({
  timeline,
  hrefFor = (r) => taskHref(r.key),
  emptyText = "This project has no cards yet.",
  targetDate = null,
  of = "cards",
  closed = [],
  toggleHref,
  finished = false,
}: {
  timeline: Pick<TimelineData, "rows" | "links" | "forecastAsOf">;
  /** Where a row's key leads. A card's own page unless told otherwise. */
  hrefFor?: (row: TimelineRow) => string;
  emptyText?: string;
  /** One date to mark down the whole chart: a project's target, on that project's timeline. */
  targetDate?: string | null;
  /** What a row is, which decides the words in the key above the chart. */
  of?: "cards" | "projects";
  /** Ids of the rows whose cards under them are hidden. */
  closed?: number[];
  /**
   * The address of this timeline with those rows closed. Given, each row with cards under it
   * gets an arrow to hide or show them; the page is drawn again on the server, so the bars and
   * the dependency arrows always match the rows on screen.
   */
  toggleHref?: (closed: number[]) => string;
  /**
   * Whether the chart reaches back to show finished work in full. Work that is still open is
   * always drawn from the day it started; this adds what is already finished, however long ago.
   */
  finished?: boolean;
}) {
  const { rows: allRows, links } = timeline;
  if (allRows.length === 0) {
    return <p className={`${CARD_BASE} p-4 text-sm text-sdc-gray-600`}>{emptyText}</p>;
  }

  // ---- which rows are drawn ----
  // Rows arrive parent first, so everything under a closed row is the run of deeper rows after it.
  const shut = new Set(closed);
  const rows: TimelineRow[] = [];
  /** Every row -> the row drawn for it: itself, or the closed row it is hidden under. */
  const shownAs = new Map<number, number>();
  const hiddenUnder = new Map<number, number>();
  let hiding: { id: number; depth: number } | null = null;
  for (const r of allRows) {
    if (hiding && r.depth > hiding.depth) {
      shownAs.set(r.id, hiding.id);
      hiddenUnder.set(hiding.id, (hiddenUnder.get(hiding.id) ?? 0) + 1);
      continue;
    }
    hiding = r.isParent && shut.has(r.id) ? { id: r.id, depth: r.depth } : null;
    rows.push(r);
    shownAs.set(r.id, r.id);
  }
  const parents = allRows.filter((r) => r.isParent).map((r) => r.id);
  const keyOf = new Map(allRows.map((r) => [r.id, r.key]));

  // ---- the span of days to draw ----
  // Every bar was worked out for the day of the last forecast run, so that is the day the line
  // marks. It is called Today only when it is today; otherwise it is named by its date.
  const realToday = localToday();
  const today = timeline.forecastAsOf ?? realToday;
  const stale = today !== realToday;
  const todayN = dayNumber(today);
  const dated: number[] = [todayN];
  for (const r of allRows) {
    if (r.start) dated.push(dayNumber(r.start));
    if (r.finish) dated.push(dayNumber(r.finish));
    if (r.p80Finish) dated.push(dayNumber(r.p80Finish));
    if (r.dueDate && r.category !== "done") dated.push(dayNumber(r.dueDate));
    // Open work reaches back to the day it started. Work finished long ago would stretch the
    // chart for nothing, so only the recent is shown unless finished work was asked for.
    if (r.startedOn && (finished || r.category !== "done")) dated.push(dayNumber(r.startedOn));
    if (r.doneOn && (finished || dayNumber(r.doneOn) >= todayN - 14)) dated.push(dayNumber(r.doneOn));
  }
  if (targetDate) dated.push(dayNumber(targetDate));
  const first = Math.min(...dated) - 2;
  const last = Math.max(...dated) + 4;
  const days = last - first + 1;
  // Sized so a plan of up to about eight months fits beside the card column without scrolling
  // sideways; a longer one scrolls, because a day narrower than 4px cannot be read.
  const dayWidth = Math.max(4, Math.min(22, Math.floor(960 / days)));
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
  const drawn = new Set<string>();
  const arrows = links.flatMap((l) => {
    // A link to or from a hidden card is drawn on the closed row it sits under.
    const a = rows[index.get(shownAs.get(l.fromId) ?? -1) ?? -1];
    const b = rows[index.get(shownAs.get(l.toId) ?? -1) ?? -1];
    if (!a || !b || a.id === b.id || drawn.has(`${a.id}-${b.id}`)) return [];
    drawn.add(`${a.id}-${b.id}`);
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
    return [{ key: `${a.id}-${b.id}`, path, label: `${keyOf.get(l.toId)} waits on ${keyOf.get(l.fromId)}` }];
  });

  const notDrawn = allRows.filter((r) => !r.isParent && r.category !== "done" && !r.finish).length;

  return (
    <div className="space-y-3">
      <Legend of={of} stale={stale} grouped={parents.length > 0} />
      {toggleHref && parents.length > 0 && (
        <p className="flex gap-4 text-xs">
          <Link href={toggleHref(parents)} scroll={false} className="font-semibold text-sdc-blue hover:underline">
            Collapse all
          </Link>
          <Link href={toggleHref([])} scroll={false} className="font-semibold text-sdc-blue hover:underline">
            Expand all
          </Link>
        </p>
      )}
      <div className={`${CARD_BASE} flex overflow-hidden`}>
        {/* The cards, as a fixed column that stays put while the dates scroll. */}
        <div className="w-80 shrink-0 border-r border-sdc-border">
          <div style={{ height: HEAD }} className="border-b border-sdc-border" />
          {rows.map((r) => (
            <div
              key={r.id}
              style={{ height: ROW, paddingLeft: 8 + r.depth * 16 }}
              className="relative flex items-center gap-1.5 overflow-hidden whitespace-nowrap border-b border-sdc-border-soft pr-2 text-xs"
            >
              {/* One line per level above this row, under the arrow of the card it belongs to. */}
              {Array.from({ length: r.depth }, (_, level) => (
                <span
                  key={level}
                  aria-hidden="true"
                  style={{ left: 16 + level * 16 }}
                  className="absolute inset-y-0 w-px bg-sdc-border"
                />
              ))}
              {toggleHref &&
                (r.isParent ? (
                  <Link
                    href={toggleHref(shut.has(r.id) ? closed.filter((id) => id !== r.id) : [...closed, r.id])}
                    scroll={false}
                    aria-expanded={!shut.has(r.id)}
                    aria-label={`${shut.has(r.id) ? "Show" : "Hide"} the ${of === "projects" ? "projects" : "cards"} under ${r.key || r.title}`}
                    title={`${shut.has(r.id) ? "Show" : "Hide"} the ${of === "projects" ? "projects" : "cards"} under ${r.key || r.title}`}
                    className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded bg-white text-sdc-gray-600 hover:bg-sdc-gray-100 hover:text-sdc-navy"
                  >
                    {shut.has(r.id) ? "\u25B8" : "\u25BE"}
                  </Link>
                ) : (
                  <span className="w-4 shrink-0" />
                ))}
              {/* A department's row on the timeline of all projects has a name and no key. */}
              {r.key && (
                <Link href={hrefFor(r)} className="font-mono font-semibold text-sdc-blue hover:underline">
                  {r.key}
                </Link>
              )}
              <span
                title={r.title}
                className={`truncate ${r.isParent ? "font-semibold text-sdc-navy" : "text-sdc-navy"} ${
                  r.category === "done" ? "text-sdc-gray-400 line-through" : ""
                }`}
              >
                {r.title}
              </span>
              {hiddenUnder.has(r.id) && (
                <span className="shrink-0 text-micro text-sdc-gray-600">{hiddenUnder.get(r.id)} hidden</span>
              )}
              {r.uncountedHours != null && (
                <span
                  title={`${hours(r.uncountedHours)} entered on ${r.key} are not counted, because cards sit under it. Open it to clear them.`}
                  className="shrink-0 rounded-full bg-sdc-yellow-bg px-1.5 text-micro font-bold text-sdc-yellow-text"
                >
                  {hours(r.uncountedHours)} not counted
                </span>
              )}
              {r.kindLabel !== "Task" && (
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
                {stale ? `As of ${shortDate(today)}` : "Today"}
              </span>
            </div>
            {targetDate && (
              <div
                style={{ left: x(dayNumber(targetDate) + 1), top: HEAD - 14, bottom: 0 }}
                className="absolute w-0 border-l border-dashed border-sdc-red"
                title={`Project target: ${shortDate(targetDate)}`}
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
                r.p80Finish ? `safe date ${shortDate(r.p80Finish)}` : null,
                r.dueDate ? `due ${shortDate(r.dueDate)}` : null,
                r.isParent ? (of === "projects" ? "spans its projects" : "spans the cards under it") : r.assigneeName,
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
                            title={`${r.key}: safe date ${shortDate(r.p80Finish)}, 4 chances in 5 it is finished by then`}
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
                          style={{
                            left: b.from,
                            width: Math.max(4, b.to - b.from),
                            top: ROW / 2 - 7,
                            ...(r.category === "blocked" ? BLOCKED_STRIPES : {}),
                          }}
                          className={`absolute h-3.5 rounded ${BAR_TONE[r.category]}`}
                        />
                      </>
                    ))}
                  {(() => {
                    // What has already happened: from the day the work started to the day it was
                    // finished, or to the forecast's day while it is still open.
                    if (!r.startedOn || r.isParent) return null;
                    const from = Math.max(first, dayNumber(r.startedOn));
                    const to = r.doneOn ? dayNumber(r.doneOn) : todayN;
                    if (to <= from) return null;
                    return (
                      <div
                        title={`${r.key} started ${shortDate(r.startedOn)}${r.doneOn ? `, finished ${shortDate(r.doneOn)}` : ""}`}
                        style={{ left: x(from), width: x(to) - x(from), top: ROW / 2 - 7 }}
                        className="absolute h-3.5 rounded-l bg-sdc-green/60"
                      />
                    );
                  })()}
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
                      // A closing bracket, so a due date never reads as the plain Today line.
                      style={{ left: x(dayNumber(r.dueDate) + 1) - 5, top: 4, bottom: 4 }}
                      className={`absolute w-1.5 border-y-2 border-r-2 ${late ? "border-sdc-red" : "border-sdc-gray-600"}`}
                    />
                  )}
                  {r.dueDate && r.category !== "done" && late && (
                    // Said with a mark as well as with red.
                    <span
                      aria-hidden="true"
                      style={{ left: x(dayNumber(r.dueDate) + 1) + 3 }}
                      className="absolute top-1/2 -translate-y-1/2 text-xs font-bold leading-none text-sdc-red-text"
                    >
                      !
                    </span>
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

      {stale && (
        <p role="status" className="text-xs font-semibold text-sdc-yellow-text">
          This forecast was made for {shortDate(today)}, not today, so its dates may be out of date. It is redone
          whenever a card or the plan changes.
        </p>
      )}
      {notDrawn > 0 && (
        <p className="text-xs text-sdc-gray-600">
          {notDrawn} open {of === "projects" ? "project" : "card"}
          {notDrawn === 1 ? " has" : "s have"} no bar because the forecast could not place{" "}
          {notDrawn === 1 ? "it" : "them"}. The row says why.
        </p>
      )}
    </div>
  );
}
