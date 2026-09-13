// Job Status vocabulary shared between the two hiring position sources
// (2026-08-19) — the Job.xlsx workbook's own free-text "Job Status"/"Job Sub
// Status" columns, and HiringPositionCreated's fixed vocabulary for
// positions made inside SDC Reports. Dependency-free so both server code and
// client components (the status filter, the Create Position form) import the
// same list.
//
// The live workbook (inspected 2026-08-19) currently carries exactly one
// value, "Published" — this Paylocity export appears to already be scoped to
// currently-open requisitions, so there is no observed "Filled"/"Cancelled"
// text to confirm against. CLOSED_STATUS_KEYWORDS stays a generic keyword
// match (not a hardcoded list of specific statuses) so a differently-worded
// closed status the export starts including later — or a manually-created
// position's own status below — is still classified correctly without a
// code change.
const CLOSED_STATUS_KEYWORDS = ["filled", "closed", "cancelled", "canceled", "withdrawn", "expired", "on hold"];

/**
 * Whether a position (from EITHER source) should count as currently open —
 * the one function driving hiring/planned-headcount totals for both. Checked
 * on status AND sub-status text (not just archived) so a recruiter marking a
 * requisition Filled/Cancelled in the text still stops it counting even if
 * the row hasn't been archived yet.
 */
export function isOpenHiringStatus(status: string, subStatus: string | null, archived: boolean): boolean {
  if (archived) return false;
  const s = status.toLowerCase();
  const sub = (subStatus ?? "").toLowerCase();
  return !CLOSED_STATUS_KEYWORDS.some((k) => s.includes(k) || sub.includes(k));
}

// The fixed vocabulary for a position CREATED in SDC Reports — unlike the
// workbook, nothing external dictates these, so they're validated at write
// time rather than merely displayed. Four statuses (2026-08-21, by request):
// "Cancelled" was dropped and "Published" added, so this list and the
// workbook's own observed vocabulary are finally the same four words.
//
// Open-ness is NOT re-decided here: isOpenHiringStatus above stays the one
// rule, and it already reads Open/Published as open and On Hold/Filled as
// closed (the latter two match a CLOSED_STATUS_KEYWORDS entry). Adding
// "Published" therefore changes nothing about hiring hours or planned
// headcount — a manually-created Published position counts exactly like the
// workbook's Published rows always have.
export const MANUAL_JOB_STATUSES = ["Open", "Published", "On Hold", "Filled"] as const;
export type ManualJobStatus = (typeof MANUAL_JOB_STATUSES)[number];
export const DEFAULT_MANUAL_JOB_STATUS: ManualJobStatus = "Open";

export function isManualJobStatus(value: string): value is ManualJobStatus {
  return (MANUAL_JOB_STATUSES as readonly string[]).includes(value);
}

/**
 * How a status LOOKS, everywhere a hiring position is rendered (2026-08-21):
 * the row's left accent, its background tint, and the pill's own dot/text.
 * One entry per status so the table badge, the row styling, the filter and
 * both forms can never drift into three different ideas of what "On Hold"
 * looks like — the request's "same centralized status configuration".
 *
 * Every colour is an EXISTING palette token (globals.css) rather than a new
 * hue: green = Open, blue = Published, the palette's yellow = the requested
 * amber for On Hold, gray = Filled. Tints are those same tokens at low alpha,
 * so a tinted row is a wash of its status colour and never a solid band.
 */
export type HiringStatusStyle = {
  /** Pill text. For an off-vocabulary workbook status this is the raw text itself, never a guessed mapping. */
  label: string;
  /** Row background tint — deliberately very light. */
  tint: string;
  /** Thin left accent border colour. */
  accent: string;
  /** Pill background + text. */
  pill: string;
  /** The pill's leading dot. */
  dot: string;
};

const STATUS_STYLES: Record<ManualJobStatus, HiringStatusStyle> = {
  Open: {
    label: "Open",
    tint: "bg-sdc-green-bg/40",
    accent: "border-l-sdc-green",
    pill: "bg-sdc-green-bg text-sdc-green-text",
    dot: "bg-sdc-green",
  },
  Published: {
    label: "Published",
    tint: "bg-sdc-blue-light/40",
    accent: "border-l-sdc-blue",
    pill: "bg-sdc-blue-light text-sdc-blue-dark",
    dot: "bg-sdc-blue",
  },
  "On Hold": {
    label: "On Hold",
    tint: "bg-sdc-yellow-bg/45",
    accent: "border-l-sdc-yellow",
    pill: "bg-sdc-yellow-bg text-sdc-yellow-text",
    dot: "bg-sdc-yellow",
  },
  Filled: {
    label: "Filled",
    tint: "bg-sdc-gray-50",
    accent: "border-l-sdc-border",
    pill: "bg-sdc-gray-100 text-sdc-muted",
    dot: "bg-sdc-muted",
  },
};

/**
 * Which of the four statuses a raw status string IS, or null for anything
 * else. Case/whitespace-insensitive because the workbook column is free
 * text; deliberately NOT a fuzzy closed-status match — a workbook row still
 * reading "Cancelled" or "Withdrawn" must not be relabelled as "Filled", so
 * it resolves to null and hiringStatusStyle() below shows its own real text.
 */
export function manualJobStatusOf(raw: string): ManualJobStatus | null {
  const v = raw.trim().toLowerCase();
  return MANUAL_JOB_STATUSES.find((s) => s.toLowerCase() === v) ?? null;
}

/**
 * The one status→appearance lookup. An off-vocabulary status keeps its own
 * text and renders in the neutral treatment, so it stays readable and
 * obviously not one of the four rather than being silently coerced into one.
 */
export function hiringStatusStyle(raw: string): HiringStatusStyle {
  const key = manualJobStatusOf(raw);
  if (key) return STATUS_STYLES[key];
  return { ...STATUS_STYLES.Filled, label: raw.trim() || "Unknown" };
}
