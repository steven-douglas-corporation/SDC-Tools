import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entraDisplayName,
  entraEmail,
  entraSettings,
  entraSettingsProblem,
  entraSignInRefusal,
} from "../src/lib/entra-sign-in";

const TENANT = "11111111-2222-3333-4444-555555555555";
const full = {
  AUTH_MICROSOFT_ENTRA_ID_ID: "client-id",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret",
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT,
};

test("with nothing set, Microsoft sign-in is off and that is not a problem", () => {
  assert.equal(entraSettings({}), null);
  assert.equal(entraSettingsProblem({}), null);
  assert.equal(entraSettings({ AUTH_MICROSOFT_ENTRA_ID_ID: "  " }), null);
  assert.equal(entraSettingsProblem({ AUTH_MICROSOFT_ENTRA_ID_ID: "  " }), null);
});

test("with all three set, the issuer is the single-tenant one", () => {
  const s = entraSettings(full);
  assert.deepEqual(s, {
    clientId: "client-id",
    clientSecret: "client-secret",
    tenantId: TENANT,
    issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  });
  assert.equal(entraSettingsProblem(full), null);
});

test("a half-set configuration stays off and says what is missing", () => {
  const partial = { AUTH_MICROSOFT_ENTRA_ID_ID: "client-id" };
  assert.equal(entraSettings(partial), null);
  assert.match(
    entraSettingsProblem(partial) ?? "",
    /AUTH_MICROSOFT_ENTRA_ID_SECRET and AUTH_MICROSOFT_ENTRA_ID_TENANT_ID are not set/,
  );
  const noSecret = { ...full, AUTH_MICROSOFT_ENTRA_ID_SECRET: "" };
  assert.match(entraSettingsProblem(noSecret) ?? "", /AUTH_MICROSOFT_ENTRA_ID_SECRET is not set/);
});

test("a tenant that is not a directory id is refused, so 'common' can never open it to other organisations", () => {
  for (const tenantId of ["common", "organizations", "sdcautomation.com", `${TENANT}/x`]) {
    const env = { ...full, AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: tenantId };
    assert.equal(entraSettings(env), null, tenantId);
    assert.match(entraSettingsProblem(env) ?? "", /must be the Directory \(tenant\) ID/, tenantId);
  }
});

test("the address is the email claim, else the sign-in name, lowercased", () => {
  assert.equal(entraEmail({ email: " JPerry@SDCAutomation.com " }), "jperry@sdcautomation.com");
  assert.equal(entraEmail({ preferred_username: "JPerry@sdcautomation.com" }), "jperry@sdcautomation.com");
  assert.equal(
    entraEmail({ email: "a@sdcautomation.com", preferred_username: "b@sdcautomation.com" }),
    "a@sdcautomation.com",
  );
  assert.equal(entraEmail({ email: "", preferred_username: "b@sdcautomation.com" }), "b@sdcautomation.com");
  assert.equal(entraEmail({ email: "not an address" }), null);
  assert.equal(entraEmail({ email: 42, preferred_username: null }), null);
  assert.equal(entraEmail({}), null);
});

test("a sign-in is accepted only from our directory and a company address", () => {
  const settings = entraSettings(full)!;
  const ok = { tid: TENANT.toUpperCase(), email: "jperry@sdcautomation.com", name: "J Perry" };
  assert.equal(entraSignInRefusal(ok, settings), null);

  assert.match(entraSignInRefusal({ ...ok, tid: "99999999-2222-3333-4444-555555555555" }, settings) ?? "", /directory/);
  assert.match(
    entraSignInRefusal({ email: ok.email }, settings) ?? "",
    /directory/,
    "a missing tid is a refusal, not a pass",
  );
  assert.match(entraSignInRefusal({ tid: TENANT }, settings) ?? "", /no email address/);
  assert.match(entraSignInRefusal({ tid: TENANT, email: "someone@gmail.com" }, settings) ?? "", /company email/);
  // An address that merely CONTAINS the company domain is not a company address.
  assert.match(
    entraSignInRefusal({ tid: TENANT, email: "x@sdcautomation.com.evil.example" }, settings) ?? "",
    /company email/,
  );
});

test("the display name is used only when the token carries one", () => {
  assert.equal(entraDisplayName({ name: "  J Perry " }), "J Perry");
  assert.equal(entraDisplayName({ name: "   " }), null);
  assert.equal(entraDisplayName({}), null);
});
