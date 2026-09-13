import { test } from "node:test";
import assert from "node:assert/strict";
import { isCompanyEmail } from "../src/lib/company-email";

test("a company email is accepted", () => {
  assert.equal(isCompanyEmail("jperry@sdcautomation.com"), true);
});

test("matching is case-insensitive", () => {
  assert.equal(isCompanyEmail("JPerry@SDCAutomation.COM"), true);
});

test("surrounding whitespace doesn't defeat the check", () => {
  assert.equal(isCompanyEmail("  jperry@sdcautomation.com  "), true);
});

test("a personal email is rejected", () => {
  assert.equal(isCompanyEmail("jperry@gmail.com"), false);
});

test("a lookalike domain is rejected, not just prefix-matched", () => {
  assert.equal(isCompanyEmail("jperry@sdcautomation.com.evil.com"), false);
});

test("a domain that merely contains the company name is rejected", () => {
  assert.equal(isCompanyEmail("jperry@notsdcautomation.com"), false);
});
