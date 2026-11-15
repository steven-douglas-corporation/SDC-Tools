import type { BoardTask } from "../service/queries";

// How the tracker's screens word dates and forecast reasons. Dependency-free so it can be
// unit-tested and used from both server and client components.

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-23" -> "Mon Nov 23". Parsed as a calendar date, never through a time zone. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** Hours without a trailing ".0": 6 -> "6 h", 4.5 -> "4.5 h". */
export function hours(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Number.isInteger(value) ? value : Math.round(value * 10) / 10} h`;
}

type ReasonInput = Pick<
  BoardTask,
  | "driver"
  | "driverTaskKey"
  | "priorityFromKey"
  | "unscheduledReason"
  | "assigneeName"
  | "expectedUnblockDate"
  | "forecastFinish"
>;

const UNSCHEDULED: Record<string, string> = {
  "no estimate": "Not forecast: it has no estimate yet.",
  "no assignee": "Not forecast: nobody is assigned.",
  blocked: "Not forecast: blocked, with no expected unblock date.",
  "no capacity profile": "Not forecast: the assignee has no capacity set.",
  "no capacity within horizon": "Not forecast: the assignee has no free time in the next three years.",
  "no allocation to this project": "Not forecast: the assignee has no share of their time on this project.",
  "role pool has no members with capacity": "Not forecast: its role pool has nobody available.",
  "dependency cycle": "Not forecast: its dependencies form a loop.",
  "project has no stack rank": "Not forecast: the project has no stack rank yet.",
  "project on hold": "Not forecast: the project is on hold.",
};

/**
 * One plain sentence on why a task's forecast is what it is. The engine records the reason;
 * this is the only place that turns it into words.
 */
export function forecastReason(t: ReasonInput): string {
  if (t.unscheduledReason) {
    const known = UNSCHEDULED[t.unscheduledReason];
    if (known) return known;
    const waiting = /^blocked by unscheduled predecessor (.+)$/.exec(t.unscheduledReason);
    if (waiting) return "Not forecast: it waits on work that is not forecast itself.";
    return `Not forecast: ${t.unscheduledReason}.`;
  }
  if (!t.forecastFinish) return "No forecast yet.";
  const pulled = t.priorityFromKey ? ` Moved up because ${t.priorityFromKey} waits on it.` : "";
  switch (t.driver) {
    case "predecessor":
      return `Starts after ${t.driverTaskKey ?? "the work it waits on"} finishes.${pulled}`;
    case "resource":
      return `Starts when ${t.assigneeName ?? "the assignee"} is free of higher-priority work.${pulled}`;
    case "not_before":
      return `Starts on its not-before date.${pulled}`;
    case "blocked_until":
      return `Starts when it is expected to be unblocked (${shortDate(t.expectedUnblockDate)}).${pulled}`;
    default:
      return `Can start now.${pulled}`;
  }
}
