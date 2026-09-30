// The ONE employee-name match key, shared by every name comparison in the app.
//
// Moved out of sync-scheduler-team.ts on 2026-09-30, unchanged, so the pure
// Paylocity roster planner (paylocity-roster-parse.ts) can use it without pulling
// in that file's Prisma and Scheduler-database imports. sync-scheduler-team.ts
// re-exports it, so every existing importer is unaffected.

// Common short-form → formal first names, so the Scheduler's casual names
// ("Mike", "Josh", "Rich") match ETC's formal ones ("Michael", "Joshua",
// "Richard"). Validated against the live roster: expanding these plus the
// last name matched 48/52 with zero false collisions (the remaining 4 aren't
// in ETC's roster at all). Last name is always kept, so an expansion can't
// collapse two different people (e.g. Josh vs Jonathan Belliveau stay distinct).
const NICKNAMES: Record<string, string> = {
  mike: "michael", josh: "joshua", rich: "richard", tim: "timothy",
  matt: "matthew", rob: "robert", dave: "david", mitch: "mitchell",
  nick: "nicholas", greg: "gregory", dan: "daniel", tom: "thomas",
  jon: "jonathan", chris: "christopher", andy: "andrew", bill: "william",
  billy: "william", sam: "samuel", joe: "joseph", jim: "james", ben: "benjamin",
};

// Whitespace-insensitive, case-insensitive, punctuation-stripped, nickname-
// expanded match key. Used by employee-scheduler-overlay.ts, sync-scheduler-team.ts
// and paylocity-roster-parse.ts — a second, slightly different normalizer would
// silently disagree with "Reconcile with Scheduler" about who matches whom.
export function normalizeName(name: string): string {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]/g, " ") // drop dots, hyphens, accents → space
    .trim()
    .split(/\s+/);
  if (parts.length > 0) parts[0] = NICKNAMES[parts[0]] ?? parts[0];
  return parts.join("");
}
