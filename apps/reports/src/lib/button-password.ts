import { createHmac, timingSafeEqual } from "crypto";

// THE single source of the password behind every protected button in the app.
//
// The phrase was changed on 2026-08-04, by request. That change is
// the reason this file exists: the phrase was declared in FIVE separate places
// (etc-actions' SUBMIT_LOCK_PASSWORD, confirm-password.ts, and three gates —
// Projects, Standard Sheet, Audit Log — retired 2026-08-18 in favor of the real
// role system, lib/permissions.ts) and two of them were additionally overridden
// by values in .env — so "change the password" meant finding seven things, and
// missing any one of them would leave the old phrase working on some buttons and
// not others. Now there is one, for what's left: Submit and Reopen Month.
//
// ── What these gates are and are not ────────────────────────────────────────
// They are "are you sure" steps in front of actions that FREEZE or DESTROY —
// Submit and Reopen Month. They are deliberately NOT an access-control boundary:
// the app's real authentication is next-auth, and every one of these buttons is
// already behind a signed-in session. A short shared phrase is appropriate for a
// deliberate-gesture gate and would not be for authentication — access
// boundaries (who may see or edit what) are lib/permissions.ts's job now.
//
// Never checked client-side, and never sent to the browser: every caller of this
// module is a server action or a server-only module, which is what keeps the phrase
// out of the client bundle, out of error responses and out of the audit log.
const DEFAULT_BUTTON_PASSWORD = "SDC";

export type ButtonGate = "submit" | "confirm";

const ENV_BY_GATE: Record<ButtonGate, string | undefined> = {
  submit: undefined, // no override — Submit uses the shared phrase
  confirm: "CONFIRM_PASSWORD",
};

export function expectedButtonPassword(gate: ButtonGate): string {
  const key = ENV_BY_GATE[gate];
  const configured = key ? process.env[key] : undefined;
  return configured && configured.length > 0 ? configured : DEFAULT_BUTTON_PASSWORD;
}

// Constant-time comparison over same-length digests. A plain `===` on the raw
// strings leaks how much of the phrase matched through timing, and hashing first
// means the comparison length does not vary with the input either.
export function matchesButtonPassword(attempt: string, gate: ButtonGate): boolean {
  const a = createHmac("sha256", "cmp").update(attempt).digest();
  const b = createHmac("sha256", "cmp").update(expectedButtonPassword(gate)).digest();
  return timingSafeEqual(a, b);
}
