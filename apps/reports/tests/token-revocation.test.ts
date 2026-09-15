import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { invalidateTokenVersionCache, TOKEN_VERSION_CACHE_KEY } from "../src/lib/token-revocation";

// ── One token-version cache per process, not per bundle (2026-09-14) ────────
//
// Next bundles a module once per bundle layer (proxy, Server Components, Route
// Handlers, Server Actions). A module-level `const _cache = new Map()` was therefore
// several Maps: the sign-out route handler's invalidateTokenVersionCache cleared its
// own copy, and the layout's currentTokenVersion kept serving the proxy bundle's
// cached "active" for up to CACHE_MS — the exact window the file's own comment said
// a revoke does NOT have to wait out. Pinning the Map on globalThis (lib/prisma.ts,
// lib/permissions.ts pattern) makes every copy of the module share one.

type CacheShape = Map<number, { version: number; active: boolean; fetchedAt: number }>;
const slot = () => (globalThis as Record<string, unknown>)[TOKEN_VERSION_CACHE_KEY] as CacheShape | undefined;

test("importing the module pins its cache on globalThis", () => {
  const cache = slot();
  assert.ok(cache instanceof Map, `expected a Map at globalThis.${TOKEN_VERSION_CACHE_KEY}`);
});

test("a revoke clears the entry in the SHARED slot — what a second bundle's currentTokenVersion would read", () => {
  // A second copy of the module would hold a reference to this same Map (it
  // reads the slot before creating one). Simulate that copy having cached a
  // verified value for user 7...
  const cache = slot()!;
  cache.set(7, { version: 3, active: true, fetchedAt: Date.now() });
  assert.ok(cache.has(7));
  // ...and this copy revoking it. The shared entry must be gone, not just "this
  // bundle's" entry.
  invalidateTokenVersionCache(7);
  assert.equal(cache.has(7), false, "the revoke must reach the one shared cache");
});

test("a re-evaluated module reuses the existing slot rather than replacing it", () => {
  // The `??=` contract: the slot is created once and never overwritten, so a
  // later bundle (or a dev hot-reload) adopts the live Map — and the values the
  // first bundle cached — instead of installing an empty one over it.
  const src = readFileSync(join(process.cwd(), "src", "lib", "token-revocation.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.match(src, /globalThis[\s\S]*__sdcTokenVersionCache\s*\?\?=\s*new Map\(\)/, "must adopt an existing slot before creating one");
  assert.doesNotMatch(src, /^const _cache = new Map/m, "a bare module-level Map is one Map PER BUNDLE — the bug this test exists for");
});
