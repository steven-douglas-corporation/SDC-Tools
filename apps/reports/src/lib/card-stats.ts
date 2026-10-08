// What the stat block at the top of a department card says (2026-10-08). One
// model for both card types — the Cards view and the Org chart — so the two can't
// drift apart again: they had each grown their own two-line version (people on one
// line, hours on the next) and with "inactive" added it no longer fit the card.
//
// Pure: numbers in, rows out. Hours arrive pre-formatted-by-caller so this stays
// free of UI imports and testable without a browser.
//
//   No openings:        21 people · 43,680 hrs/yr          (one line)
//   With openings:                People   Hrs/yr
//                       Current       21   43,680
//                       + Hiring      +2   +4,160
//                       Planned       23   47,840
//   Inactive people, only when some are drawn, as a quiet note under either.

export type CardStatsInput = {
  /** Active people on the card — the headcount the capacity hours are built on. */
  active: number;
  /** Inactive people drawn on the card (only with "Show inactive"); never in the numbers above. */
  inactive?: number;
  /** Open positions placed on this card. */
  hiringOpenings: number;
  /** Null when the year has no capacity policy: the card then shows people only. */
  currentHours: number | null;
  /** Hours the open positions add; ignored without a capacity policy. */
  hiringHours: number;
};

export type CardStatRow = {
  key: "current" | "hiring" | "planned";
  label: string;
  people: string;
  /** Null: no capacity policy for the year, so there is no hours column. */
  hours: string | null;
};

export type CardStats = {
  rows: CardStatRow[];
  /** More than one row: drawn as a small table; one row is a single line. */
  table: boolean;
  inactive: number;
};

export function cardStats(input: CardStatsInput, fmtHours: (n: number) => string): CardStats {
  const { active, hiringOpenings, currentHours, hiringHours } = input;
  const hasHours = currentHours != null;
  const rows: CardStatRow[] = [{ key: "current", label: "Current", people: String(active), hours: hasHours ? fmtHours(currentHours) : null }];
  if (hiringOpenings > 0) {
    rows.push(
      { key: "hiring", label: "+ Hiring", people: `+${hiringOpenings}`, hours: hasHours ? `+${fmtHours(hiringHours)}` : null },
      { key: "planned", label: "Planned", people: String(active + hiringOpenings), hours: hasHours ? fmtHours(currentHours + hiringHours) : null },
    );
  }
  return { rows, table: rows.length > 1, inactive: Math.max(0, input.inactive ?? 0) };
}
