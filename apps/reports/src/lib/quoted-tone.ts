// The Projects grid's over/under cell tone, in one place.
//
// A section cell is tinted by how its ACTUAL hours compare to its QUOTED ones:
//
//   red    — actual has passed quoted (over)
//   green  — the job is Complete and did not go over
//   yellow — still running, at or under quoted
//   none   — nothing quoted and nothing worked; an empty cell is not a status
//
// Extracted from quoted/page.tsx (2026-08-03) because the tone is now decided in
// two places: the server render, and ProjectsLiveTotals re-deciding it in the
// browser when the quoted number or the row's Status is edited. Two copies of a
// three-way rule is how a cell ends up green on the server and yellow after a
// keystroke, so both call this.
//
// Pure and dependency-free, so it can be unit-tested and imported from both a
// server component and a client one.

export const TONE_OVER = "bg-red-100";
export const TONE_COMPLETE = "bg-sdc-green-bg/60";
export const TONE_UNDER = "bg-sdc-yellow-bg/50";

// Every class this function can return — what a caller must strip before
// applying a new one. Listed rather than derived so a future tone can't be added
// without the removal list noticing.
export const TONE_CLASSES = [TONE_OVER, TONE_COMPLETE, TONE_UNDER] as const;

export function quotedCellTone({ quoted, actual, jobComplete }: { quoted: number; actual: number; jobComplete: boolean }): string {
  if (quoted <= 0 && actual <= 0) return "";
  if (actual > quoted) return TONE_OVER;
  return jobComplete ? TONE_COMPLETE : TONE_UNDER;
}
