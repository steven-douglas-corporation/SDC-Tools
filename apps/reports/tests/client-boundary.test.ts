import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// ── A React hook may not be called from a server component (2026-08-28) ─────
//
// This exists because it shipped and took the whole Dashboard down at request
// time:
//
//   ⨯ Error: Attempted to call useJobDrill() from the server but useJobDrill is
//     on the client. It's not possible to invoke a client function from the
//     server, it can only be rendered as a Component or passed to props of a
//     Client Component.
//
// A hook was added to DashboardOverview.tsx, which has no "use client".
//
// ── Why nothing else caught it ──────────────────────────────────────────────
//
// - `tsc` does not model the RSC boundary at all; the code type-checks.
// - `next build` PASSED. The Dashboard is a dynamic route (ƒ), so it is never
//   prerendered at build time and the boundary is only crossed on a real
//   request. A green build is not evidence here.
// - ESLint's react-hooks rules check hook ORDER, not which side of the boundary
//   the file is on.
//
// So the cheapest reliable check is this one: scan the component sources and
// require that any file calling a hook declares "use client". That is exactly
// the rule the runtime enforces, applied statically.

const COMPONENTS = join(process.cwd(), "src", "components");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Strips comments and string literals so a hook NAMED in prose is not read as a call. */
function stripNoise(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

// `use` itself (React 19's) is legal in a server component, as are the two
// Next.js server helpers that happen to match the use* shape.
const SERVER_SAFE = new Set(["use", "useId"]);

test("every component that calls a React hook is a client component", () => {
  const offenders: string[] = [];

  for (const file of walk(COMPONENTS)) {
    const raw = readFileSync(file, "utf8");
    const isClient = /^\s*(["'])use client\1/m.test(raw.slice(0, 200));
    if (isClient) continue;

    const code = stripNoise(raw);
    // A hook CALL: use<Uppercase>… immediately followed by "(". Excludes
    // imports (`import { useX }`), type positions, and prose.
    const called = new Set<string>();
    for (const m of code.matchAll(/\b(use[A-Z]\w*)\s*\(/g)) {
      if (!SERVER_SAFE.has(m[1])) called.add(m[1]);
    }
    // An import alone is fine — a server component may import a client
    // component's module. Only a CALL is the error.
    if (called.size > 0) {
      offenders.push(`${relative(process.cwd(), file)}: ${[...called].sort().join(", ")}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these files call a React hook but have no "use client" — they will throw at request time, not at build time:\n  ${offenders.join("\n  ")}`,
  );
});

test("the guard actually detects a hook call (it is not vacuously passing)", () => {
  // A scanner that silently matches nothing would pass this suite forever. Prove
  // the detection works on a known-bad sample before trusting the empty result.
  const sample = stripNoise(`
    import { useJobDrill } from "./x";
    export function Bad() {
      const drill = useJobDrill();
      return null;
    }
  `);
  const found = [...sample.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(found, ["useJobDrill"]);
});

test("the guard ignores a hook named only in a comment or a string", () => {
  const sample = stripNoise(`
    // useJobDrill() is called by ActiveJobsSection, not here.
    /* useSomething() */
    const label = "useThing()";
    export function Fine() { return null; }
  `);
  const found = [...sample.matchAll(/\b(use[A-Z]\w*)\s*\(/g)].map((m) => m[1]);
  assert.deepEqual(found, []);
});


// ── A client component may not VALUE-import a "server-only" module ──────────
//
// The second boundary bug, and it shipped the same way the first did
// (2026-08-31): lib/employee-punch-sort.ts was split out of a client component
// and imported BUCKET_LABEL — a value — from lib/employee-punch-drill.ts, which
// is `import "server-only"`. Every page that reaches that client component then
// fails to compile at request time:
//
//   'server-only' cannot be imported from a Client Component module
//   ./src/lib/employee-punch-drill.ts [Client Component Browser]
//   ./src/lib/employee-punch-sort.ts  [Client Component Browser]
//   ./src/components/dashboard/EmployeePunchDrill.tsx [Client Component Browser]
//   -> GET / 500
//
// ── Why nothing else caught it ──────────────────────────────────────────────
//
// - `tsc` does not model the RSC boundary, same as the hook case above.
// - `npm test` CANNOT catch it by running the code: scripts/shim-server-only.cjs
//   deliberately stubs the `server-only` package so lib modules can be unit
//   tested at all. The stub is correct; it just means a green test run says
//   nothing about this.
// - `next build` DOES catch this one (unlike the hook case) — but only if you
//   run it, and the failure is a wall of import traces rather than a named rule.
//
// The rule, applied statically: follow the import graph out of every "use
// client" file through src/lib, and fail if any module reached by a VALUE
// import declares "server-only". `import type` is erased at build time and is
// explicitly fine — that distinction is the whole fix.

const LIB = join(process.cwd(), "src", "lib");

/**
 * Comments only. NOT stripNoise() — that also blanks string literals, which are
 * exactly what a module specifier is, so using it here made every import
 * invisible and the whole guard pass on an empty graph. (It did; the vacuity
 * test below is what caught it.)
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The module specifiers a file imports as VALUES — `import type` lines excluded. */
function valueImports(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  // import ... from "x"  /  import "x"
  for (const m of code.matchAll(/import\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const [, typeKeyword, clause, spec] = m;
    if (typeKeyword) continue; // `import type { A } from "x"` — erased
    // `import { type A, type B } from "x"` is also fully erased.
    const named = clause.match(/^\{([\s\S]*)\}$/);
    if (named && named[1].split(",").every((part) => !part.trim() || /^type\s/.test(part.trim()))) continue;
    out.push(spec);
  }
  for (const m of code.matchAll(/import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

function resolveLib(spec: string): string | null {
  if (!spec.startsWith("@/lib/")) return null;
  return join(LIB, `${spec.slice("@/lib/".length)}.ts`);
}

function isServerOnly(file: string): boolean {
  try {
    return /^\s*import\s+["']server-only["']/m.test(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

/**
 * A `"use server"` module is an RPC boundary, not a bundling one: a client
 * component importing a server action gets a stub, and everything the action
 * imports stays on the server. So the walk STOPS there rather than reporting it
 * — otherwise every one of the app's ~20 `*-actions.ts` files is a false
 * positive, which is exactly what the first run of this guard produced.
 *
 * The bug this test exists for had no such boundary: lib/employee-punch-sort.ts
 * is a plain module, so it really was compiled into the browser bundle.
 */
function isServerAction(src: string): boolean {
  return /^\s*["']use server["']/m.test(src);
}

/** Every server-only lib reachable from `entry` through value imports, with the path taken. */
function serverOnlyReachedFrom(entry: string): string[] {
  const seen = new Set<string>();
  const trails: string[] = [];
  const visit = (file: string, trail: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (isServerAction(src)) return;
    if (isServerOnly(file)) {
      trails.push([...trail, relative(process.cwd(), file)].join(" -> "));
      return; // its own imports are that module's problem, not a second finding
    }
    for (const spec of valueImports(src)) {
      const target = resolveLib(spec);
      if (target) visit(target, [...trail, relative(process.cwd(), file)]);
    }
  };
  visit(entry, []);
  return trails;
}

test("no client component value-imports a server-only module", () => {
  const offenders: string[] = [];
  for (const file of walk(COMPONENTS)) {
    const src = readFileSync(file, "utf8");
    if (!/^\s*["']use client["']/m.test(src)) continue;
    for (const spec of valueImports(src)) {
      const target = resolveLib(spec);
      if (!target) continue;
      for (const trail of serverOnlyReachedFrom(target)) {
        offenders.push(`${relative(process.cwd(), file)} -> ${trail}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `client components reaching "server-only" code:\n  ${offenders.join("\n  ")}`);
});

test("the server-only guard is not vacuously passing", () => {
  // It has to actually find server-only modules and actually distinguish a value
  // import from a type import, or it would pass on an empty graph.
  const serverOnlyLibs = readdirSync(LIB).filter((f) => f.endsWith(".ts") && isServerOnly(join(LIB, f)));
  assert.ok(serverOnlyLibs.length > 5, `expected several server-only libs, found ${serverOnlyLibs.length}`);

  assert.deepEqual(valueImports('import type { A } from "@/lib/x";'), []);
  assert.deepEqual(valueImports('import { type A, type B } from "@/lib/x";'), []);
  assert.deepEqual(valueImports('import { A } from "@/lib/x";'), ["@/lib/x"]);
  assert.deepEqual(valueImports('import { type A, B } from "@/lib/x";'), ["@/lib/x"]);
  assert.deepEqual(valueImports('import "server-only";'), ["server-only"]);

  // And the walk must really stop at a "use server" module, or the guard is
  // just muted rather than correct.
  assert.ok(isServerAction('"use server";\n\nexport async function x() {}'));
  assert.ok(!isServerAction('import "server-only";'));
  const anAction = join(LIB, "employee-punch-actions.ts");
  assert.ok(isServerAction(readFileSync(anAction, "utf8")), "employee-punch-actions.ts should be a server action");
  assert.ok(
    serverOnlyReachedFrom(join(LIB, "employee-punch-drill.ts")).length > 0,
    "a directly server-only lib must still be reported when nothing stops the walk",
  );
});

test("the punch sort module reaches the server boundary by TYPE only", () => {
  // The specific regression. It imports PunchBucket and EmployeeMonthPunch from
  // two server-only modules, which is fine precisely because both are `import
  // type` and are erased.
  const src = readFileSync(join(LIB, "employee-punch-sort.ts"), "utf8");
  assert.match(src, /import type \{ PunchBucket \}/);
  assert.match(src, /import type \{ EmployeeMonthPunch \}/);
  assert.deepEqual(serverOnlyReachedFrom(join(LIB, "employee-punch-sort.ts")), []);
  assert.doesNotMatch(src, /^import \{ BUCKET_LABEL/m, "BUCKET_LABEL is a value in a server-only module");
});
