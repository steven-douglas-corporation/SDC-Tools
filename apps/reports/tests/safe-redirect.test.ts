import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeRelativePath, safeRelativePath, resolveSameOrigin } from "../src/lib/safe-redirect";

// The open redirect this closes (2026-09-14): api/auth/sso accepted `?next=`
// with only next-auth's own `startsWith("/")` check between it and a Location
// header, and `new URL("//evil.example/x", base)` resolves OFF base. The same
// helper now also sanitises LoginForm's callbackUrl.

test("plain same-origin paths pass, normalised, with query and hash kept", () => {
  assert.equal(safeRelativePath("/job-hours?jobs=1079"), "/job-hours?jobs=1079");
  assert.equal(safeRelativePath("/etc#top"), "/etc#top");
  assert.equal(safeRelativePath("/"), "/");
  assert.equal(safeRelativePath("/a/./b/../c"), "/a/c");
});

test("scheme-relative and backslash forms are refused — the exact bypass", () => {
  for (const bad of ["//evil.example", "//evil.example/x", "/\\evil.example", "/\\/evil.example", "\\\\evil.example"]) {
    assert.equal(isSafeRelativePath(bad), false, bad);
    assert.equal(safeRelativePath(bad), "/", bad);
  }
});

test("absolute URLs, empty values, and non-strings fall back", () => {
  for (const bad of ["http://evil.example/", "https://reports.local/x", "javascript:alert(1)", "", "x", "?q=1", null, undefined, 42, {}]) {
    assert.equal(safeRelativePath(bad), "/", String(bad));
  }
});

test("a custom fallback is honoured", () => {
  assert.equal(safeRelativePath("//evil.example", "/job-hours"), "/job-hours");
});

test("landing back on the login page is treated as no destination", () => {
  // proxy.ts can only ever set callbackUrl for a gated route, but a hand-edited
  // URL could name /login itself — following it would be a one-step loop.
  assert.equal(safeRelativePath("/login"), "/");
  assert.equal(safeRelativePath("/login/anything"), "/");
  assert.equal(safeRelativePath("/login?callbackUrl=/x"), "/");
  // …but a route that merely STARTS with the letters is fine.
  assert.equal(safeRelativePath("/loginfoo"), "/loginfoo");
});

test("resolveSameOrigin builds an absolute URL on the request origin and never leaves it", () => {
  const origin = "http://server-app1:4006";
  assert.equal(resolveSameOrigin("/quoted?x=1", origin).href, "http://server-app1:4006/quoted?x=1");
  assert.equal(resolveSameOrigin("//evil.example/x", origin).href, "http://server-app1:4006/");
  assert.equal(resolveSameOrigin("http://evil.example/x", origin).href, "http://server-app1:4006/");
  // The SSO route sends a failed hand-off to /login — this helper must not eat that.
  assert.equal(resolveSameOrigin("/login", origin).href, "http://server-app1:4006/login");
  // Fallback is also resolved against the origin.
  assert.equal(resolveSameOrigin("//evil.example", origin, "/job-hours").href, "http://server-app1:4006/job-hours");
});

test("every accepted path really does stay on the origin it is later resolved against", () => {
  // Property check over the shapes an attacker would try.
  const origin = "https://reports.example";
  const attempts = ["/x", "//x", "/\\x", "/x//y", "/%2F%2Fevil.example", "/x?next=//evil.example", "/x#//evil.example", "/..//evil.example", "/x/../../evil.example"];
  for (const a of attempts) {
    const out = safeRelativePath(a);
    assert.equal(new URL(out, origin).origin, origin, `${a} → ${out}`);
  }
});
