// Dependency-free so both self-service password forms (login/actions.ts, a
// "use server" module that may only export async functions) and the unit test
// can read the same floor. Kept out of actions.ts for exactly that reason.

// Shortest password either self-service form accepts (2026-09-14; was 1).
// Anything reachable with one keystroke is not a password; 8 is the floor
// NIST SP 800-63B sets for user-chosen secrets.
export const MIN_PASSWORD_LENGTH = 8;

export function passwordTooShortMessage(): string {
  return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
}

/** The validation rule itself, so it can be tested without a database. */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}
