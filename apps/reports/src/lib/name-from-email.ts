/**
 * A placeholder display name for an account auto-provisioned via the Scheduler SSO
 * hand-off, where only an email address is asserted — never a full name (see
 * scheduler-sso.ts's payload). Splits the local part on the separators people actually
 * use in a work email ("jane.doe", "jane_doe", "jane-doe") and title-cases each piece;
 * falls back to title-casing the whole local part when there's nothing to split on
 * ("jdoe"). Good enough to show in a sidebar until the person (or an admin) sets a real
 * one — not attempted to be more accurate than that.
 */
export function nameFromEmail(email: string): string {
  const local = email.trim().split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const title = (s: string) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s);
  return (parts.length > 0 ? parts : [local]).map(title).join(" ").trim() || "New User";
}
