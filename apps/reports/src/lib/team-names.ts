import { DISCIPLINE_LABEL } from "@/lib/disciplines";

// The team vocabulary the Employees page speaks (2026-10-06), in a module of its
// own so a client component (the person panel's Team picker) can import it
// without pulling in team-resolution.ts and, through it, the Excel parser.

/**
 * Display names for team codes: the shared labels, plus HR, which Scheduler has
 * no bucket for, and "ops" shown as Procurement (its card's title).
 */
export const TEAM_NAME: Readonly<Record<string, string>> = { ...DISCIPLINE_LABEL, hr: "Human Resources", ops: "Procurement" };

/** Every team code, in card order: the delivery teams as work moves through them, then the back office. */
export const TEAM_CODES: readonly string[] = ["pm", "mech", "controls", "ai", "build", "wire", "service", "mfgops", "ops", "hr", "finance", "growth", "sales", "exec"];

/** Whether a value is a team the app knows, e.g. one a person's team can be set to by hand. */
export function isTeamCode(value: string | null | undefined): value is string {
  return !!value && TEAM_CODES.includes(value);
}
