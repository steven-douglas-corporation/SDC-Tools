// ── The Key Dates vocabulary: anchors, labels and row/marker shapes ────────
//
// Split out of dashboard-key-dates.ts, which is `server-only` (it reaches the
// Scheduler database). The timeline is a CLIENT component and needs the anchor
// list to draw its chips — value-importing it from the server module would drag
// a database connection into the browser bundle, which tests/client-boundary
// .test.ts fails the build for.
//
// Same split, same reason, as tm-hours-classify.ts and tm-drill-reconcile.ts.
// Pure and dependency-free: no Prisma, no mysql, no "server-only".

/** The milestone types, in the order their chips appear. Mirrors the Scheduler's KEYDATES_ANCHORS. */
export const KEY_DATE_ANCHORS = [
  { key: "receipt_of_po", short: "PO", derived: false },
  { key: "mech_release_1", short: "Mech 1", derived: false },
  { key: "parts_panel_ready", short: "Panel Ready", derived: false },
  { key: "build_start", short: "Build Start", derived: true },
  { key: "machine_power_up", short: "Power-Up", derived: false },
  { key: "fat", short: "FAT", derived: false },
  { key: "ship_machine", short: "Ship", derived: false },
  { key: "sat", short: "SAT", derived: false },
] as const;

export type KeyDateAnchor = (typeof KEY_DATE_ANCHORS)[number]["key"];

export const ANCHOR_LABEL: Record<string, string> = Object.fromEntries(
  KEY_DATE_ANCHORS.map((a) => [a.key, a.short]),
);

/** The anchors that are read straight off tasks.anchor_key. */
export const STORED_ANCHORS: readonly string[] = KEY_DATE_ANCHORS.filter((a) => !a.derived).map((a) => a.key);

export type KeyDateMarker = {
  /** Unique within a row — `<anchor>:<taskId>` or `build_start:<rowKey>`. */
  id: string;
  anchor: string;
  /** Short chip label, e.g. "Mech 1". */
  label: string;
  /** "YYYY-MM-DD". */
  date: string;
  /** Completed on this date, per the Scheduler. Drives the green state. */
  done: boolean;
  /** Not done and the date has passed. Drives the red state. */
  late: boolean;
  /** The Scheduler task's own name, for the tooltip ("FAT - Pair 3"). */
  title: string;
  assignee: string | null;
};

export type KeyDateRow = {
  /** Stable identity: job number + machine. */
  rowKey: string;
  jobNumber: string;
  /** The Scheduler schedule name — two schedules for one job stay separate rows. */
  projectName: string;
  /** "M1" … or null for a project-level row. */
  machine: string | null;
  /** What the row label shows: "1164_Centrus…(QTY 4) · M1". */
  label: string;
  markers: KeyDateMarker[];
  /** Earliest marker date in range — what rows are sorted on. */
  firstDate: string;
};

export type KeyDatesResult = {
  rows: KeyDateRow[];
  /** Inclusive month bounds actually used, "YYYY-MM". */
  from: string;
  to: string;
  /** False when the Scheduler is unreachable — the UI says so instead of showing an empty timeline as fact. */
  schedulerAvailable: boolean;
  /** Anchors with at least one marker in range, so the UI can quieten chips that would find nothing. */
  presentAnchors: string[];
};

