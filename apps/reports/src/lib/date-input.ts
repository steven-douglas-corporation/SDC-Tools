// ── Typing a date without the field fighting you (2026-09-02) ──────────────
//
// The Hours "Dates" menu is two `<input type="date">` fields whose value is bound
// to React state and whose onChange writes that state on every keystroke. That
// combination is what makes keyboard entry unusable, for two separate reasons:
//
//   1. A PARTIAL DATE READS AS EMPTY. A native date input reports `value === ""`
//      until all three segments are filled. So the moment you start retyping the
//      month of an existing date, onChange fires with "", the state clears, and
//      the field is re-rendered as empty underneath the person still typing.
//      Their remaining segments are gone. That is the "input fighting the user"
//      and the "value replacement" in the report, and it is not a cursor bug —
//      it is the control being told to forget what it holds.
//
//   2. A HALF-TYPED YEAR IS A VALID DATE. Type "9", "1", then "2" into
//      MM/DD/YYYY and the input hands you the year 0002 — a complete, parseable
//      date. The menu committed it and navigated, so the server was queried for
//      punches in the year 2, then 20, then 202, then 2026: four requests and
//      three nonsense ones, per date typed. That is the "do not call the API
//      after every digit" requirement, and no debounce fixes it, because these
//      are not repeats of one value — they are four different values, each one
//      individually plausible.
//
// The rules live here, pure, because both are logic bugs that a rendering test
// would never catch and a person clicking a calendar would never see.

/** The year range a person is plausibly filtering punch data within. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

/**
 * Is this a REAL calendar day in `YYYY-MM-DD` form?
 *
 * Checked arithmetically rather than by handing the string to `new Date()`,
 * which accepts 2026-02-31 (and quietly returns March 3rd) and which parses a
 * bare date string as UTC — the timezone shift the rest of this app is careful
 * to avoid. "Do not silently change a user's typed date to a different date"
 * means an impossible date has to be REFUSED, not rounded into a nearby one.
 */
export function isRealCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  // Day count for this month, leap years included — the one place a February
  // boundary is decided.
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= daysInMonth;
}

/**
 * Should a value the user is still typing be sent to the server yet?
 *
 * This is the guard for cause (2) above. A date input mid-entry hands over
 * complete-looking dates whose year is 2, 20 or 202 — each a valid calendar day,
 * none of them anything a person meant. Requiring a four-digit year in a
 * plausible range costs nothing (a real filter year is always four digits) and
 * removes every one of those requests.
 *
 * Deliberately NOT a debounce: these are four DIFFERENT values, so a debounce
 * only delays the nonsense rather than preventing it, and it would also delay
 * the one value that was meant.
 */
export function isCommittableDate(iso: string): boolean {
  if (!isRealCalendarDate(iso)) return false;
  const year = Number(iso.slice(0, 4));
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

/**
 * What a field's edit should do to the committed value.
 *
 * The rule that fixes cause (1): while the field HAS FOCUS, an empty value means
 * "mid-edit", not "cleared". Clearing is a thing you finish — by leaving the
 * field empty and tabbing away, or by pressing the menu's Clear button — so it
 * is committed on blur, not on the transient empty state every retype passes
 * through.
 *
 *   "hold"   — keep the committed value; the user is still typing
 *   "commit" — write `value` (a committable date)
 *   "clear"  — write nothing; the user has finished and left it empty
 */
export type DateEditOutcome = "hold" | "commit" | "clear";

export function dateEditOutcome(raw: string, focused: boolean): DateEditOutcome {
  const value = raw.trim();
  if (value === "") return focused ? "hold" : "clear";
  return isCommittableDate(value) ? "commit" : "hold";
}

/**
 * What is wrong with this range, in words, or null if nothing is.
 *
 * Both halves are reported rather than only the first: a range can be backwards
 * AND contain an impossible day, and fixing one to be told about the other is
 * the interaction this whole task is about.
 */
export function dateRangeError(from: string, to: string): string | null {
  const bad: string[] = [];
  if (from && !isRealCalendarDate(from)) bad.push("“From” is not a real date");
  if (to && !isRealCalendarDate(to)) bad.push("“To” is not a real date");
  if (bad.length > 0) return `${bad.join(" and ")}.`;
  // Same day is legitimate — one day's punches — so this is strictly greater.
  if (from && to && from > to) return "“From” is after “To” — no punch can match.";
  return null;
}
