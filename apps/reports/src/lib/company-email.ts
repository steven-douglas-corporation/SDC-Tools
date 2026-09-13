const COMPANY_DOMAIN = "@sdcautomation.com";

/**
 * Whether an email may self-register or be auto-provisioned via the Scheduler SSO
 * hand-off — shared by src/app/login/actions.ts (self-registration) and auth.ts (SSO
 * auto-provisioning), so the two gates can never independently drift. Case-insensitive;
 * does not otherwise validate the address (the sign-up form and bcrypt already reject a
 * malformed one downstream).
 */
export function isCompanyEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(COMPANY_DOMAIN);
}
