import "server-only";
import { fetchSchedulerAnchorTasks, fetchSchedulerBuildStarts, isSchedulerDbConfigured } from "@/lib/scheduler-db";
// The vocabulary lives in a PURE module so the client timeline can import it
// without reaching this file's database connection — see key-dates-anchors.ts.
import { ANCHOR_LABEL, KEY_DATE_ANCHORS, STORED_ANCHORS, type KeyDateMarker, type KeyDateRow, type KeyDatesResult } from "@/lib/key-dates-anchors";

export type { KeyDateMarker, KeyDateRow, KeyDatesResult };
export { ANCHOR_LABEL, KEY_DATE_ANCHORS };

// ── Key Dates: execution milestones on one timeline ─────────────────────────
//
// Replaces the Dashboard's month-grid Execution Calendar with the same view the
// SDC Scheduler already calls "Key Dates" — one row per project·machine, time
// running left to right, milestone diamonds on their real dates.
//
// The milestones are NOT re-derived here. The Scheduler's `tasks.anchor_key`
// column is the definition, and this reads it: the same eight anchors its own
// Key Dates view offers, so a milestone on the Dashboard and the same milestone
// in the Scheduler cannot disagree about what it is or when it is.
//
// ── What the data actually supports (measured 2026-09-01) ───────────────────
//
//   receipt_of_po      PO          61 rows
//   mech_release_1     Mech 1      57
//   machine_power_up   Power-Up    93
//   fat                FAT         93
//   ship_machine       Ship        93
//   sat                SAT         85
//   parts_panel_ready  Panel Ready  0   <- no task anywhere carries this anchor
//   build_start        Build Start  —   <- DERIVED, never an anchor row
//
// Panel Ready is offered by the Scheduler's chip list and has no data behind it
// in this database. It is kept in ANCHORS with `derived: false` so the chip
// exists and stays empty honestly, rather than being quietly dropped — if
// somebody starts anchoring Panel Ready tasks it lights up with no code change.
//
// Build Start is the Scheduler's own derived rule, reproduced: the first day any
// person of discipline `build` is assigned to that machine. It is not a
// milestone somebody sets, which is why it has no anchor_key to read.

/** "YYYY-MM" -> the first day of that month / the first day of the month after. */
function monthBounds(from: string, to: string): { start: string; endExclusive: string } {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const start = `${fy}-${String(fm).padStart(2, "0")}-01`;
  // First day of the month AFTER `to`, so the whole of `to` is included.
  const endYear = tm === 12 ? ty + 1 : ty;
  const endMonth = tm === 12 ? 1 : tm + 1;
  return { start, endExclusive: `${endYear}-${String(endMonth).padStart(2, "0")}-01` };
}

/**
 * Every selected milestone falling inside [from, to], grouped into
 * project·machine rows.
 *
 * `anchors` is passed in rather than read from a preference here: the chips live
 * in the browser, and the query should ask for exactly what is being displayed
 * rather than fetching all eight and filtering in the client.
 */
export async function getKeyDates(opts: {
  from: string;
  to: string;
  anchors: string[];
  today: string;
}): Promise<KeyDatesResult> {
  const wanted = new Set(opts.anchors.filter((a) => KEY_DATE_ANCHORS.some((k) => k.key === a)));
  const empty: KeyDatesResult = {
    rows: [],
    from: opts.from,
    to: opts.to,
    schedulerAvailable: isSchedulerDbConfigured(),
    presentAnchors: [],
  };
  if (wanted.size === 0 || !isSchedulerDbConfigured()) return empty;

  const { start, endExclusive } = monthBounds(opts.from, opts.to);
  const storedWanted = STORED_ANCHORS.filter((a) => wanted.has(a));

  // Both reads report null when the Scheduler is unreachable, so an outage
  // surfaces as "can't reach the Scheduler" rather than as an empty timeline
  // that reads like "no milestones this quarter".
  const [tasks, buildStarts] = await Promise.all([
    storedWanted.length > 0 ? fetchSchedulerAnchorTasks(storedWanted, start, endExclusive) : Promise.resolve([]),
    wanted.has("build_start") ? fetchSchedulerBuildStarts(start, endExclusive) : Promise.resolve([]),
  ]);
  if (tasks === null || buildStarts === null) return { ...empty, schedulerAvailable: false };

  const byRow = new Map<string, KeyDateRow>();
  const rowFor = (jobNumber: string, projectName: string, machine: string | null): KeyDateRow => {
    const rowKey = `${jobNumber}|${projectName}|${machine ?? ""}`;
    let row = byRow.get(rowKey);
    if (!row) {
      row = {
        rowKey,
        jobNumber,
        projectName,
        machine,
        // The Scheduler's own label shape: the schedule name, then the machine.
        label: machine ? `${projectName} · ${machine}` : projectName,
        markers: [],
        firstDate: "9999-12-31",
      };
      byRow.set(rowKey, row);
    }
    return row;
  };

  for (const t of tasks) {
    const date = t.startDate;
    if (!date) continue;
    const done = Boolean(t.completedOn);
    const row = rowFor(t.jobNumber, t.project, t.machine);
    row.markers.push({
      id: `${t.anchorKey}:${t.id}`,
      anchor: t.anchorKey,
      label: ANCHOR_LABEL[t.anchorKey] ?? t.anchorKey,
      date,
      done,
      // Late means "should have happened by now and did not". A completed
      // milestone is never late, whenever it happened.
      late: !done && date < opts.today,
      title: t.name,
      assignee: t.assignee?.trim() || null,
    });
  }

  for (const b of buildStarts) {
    const date = b.startDate;
    if (!date) continue;
    const row = rowFor(b.jobNumber, b.project, b.machine);
    row.markers.push({
      id: `build_start:${row.rowKey}`,
      anchor: "build_start",
      label: "Build Start",
      date,
      // Derived from an assignment, so there is no completion to read. Shown as
      // upcoming/late on the date alone rather than claiming a state it cannot know.
      done: false,
      late: date < opts.today,
      title: "First builder assigned",
      assignee: null,
    });
  }

  const rows = [...byRow.values()];
  for (const row of rows) {
    // Chronological within the row, so a row reads left to right like the timeline.
    row.markers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.label.localeCompare(b.label)));
    row.firstDate = row.markers[0]?.date ?? "9999-12-31";
  }
  // Soonest first — the Monday-meeting order, and the Scheduler's own default.
  rows.sort((a, b) => (a.firstDate < b.firstDate ? -1 : a.firstDate > b.firstDate ? 1 : a.label.localeCompare(b.label)));

  const presentAnchors = [...new Set(rows.flatMap((r) => r.markers.map((m) => m.anchor)))];
  return { rows, from: opts.from, to: opts.to, schedulerAvailable: true, presentAnchors };
}
