// A `require()` preload for one-off CLI scripts (run via `npx tsx -r ./scripts/shim-server-only.cjs ...`)
// that need to import app modules tagged `import "server-only"` (e.g. paylocity-workbook.ts).
//
// That guard is the real "server-only" npm package: its default export unconditionally
// throws, and it only resolves to a no-op when the bundler declares the "react-server"
// export condition (see node_modules/server-only/package.json) — something Next.js's
// webpack/Turbopack sets, and plain Node/tsx does not. Passing `node --conditions=react-server`
// looks like the fix but isn't scoped to this one package: Next's OWN dependencies (react,
// next/navigation) branch on that same condition to pick a React-Server-only build that
// doesn't work outside Next's actual RSC runtime, so the whole module graph breaks instead.
//
// This is scoped to exactly one bare specifier — redirecting "server-only" to its own
// already-published no-op (node_modules/server-only/empty.js) — so nothing else about
// module resolution changes.
// require(), not import: this file is a Node `-r`/`--require` PRELOAD hook
// (see the tsx -r invocation above), which only works as CommonJS -- that's
// also why it's a .cjs file rather than .ts. Not an oversight to migrate.
/* eslint-disable @typescript-eslint/no-require-imports */
const Module = require("module");
const path = require("path");

const emptyPath = path.join(__dirname, "..", "node_modules", "server-only", "empty.js");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "server-only") return emptyPath;
  return originalResolveFilename.call(this, request, ...rest);
};
