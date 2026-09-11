import type { NextConfig } from "next";
import { version as packageVersion } from "./package.json";

const nextConfig: NextConfig = {
  /* config options here */
  // The app version, from package.json, baked in at build time and read back
  // through lib/app-version.ts. Injected here rather than imported by the sidebar
  // so the browser bundle carries the version string and not the whole
  // package.json (dependency list included). See lib/app-version.ts.
  env: {
    NEXT_PUBLIC_APP_VERSION: packageVersion,
  },
  // Overridable so a second dev server (e.g. a preview) can run alongside
  // the main one — Next refuses two dev servers sharing one dist dir.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  allowedDevOrigins: ["server-app1", "localhost"],
  // ── mssql/tedious must be ONE instance per process (2026-09-09) ───────────
  //
  // Not an optimisation. A bundled module is bundled once PER BUNDLE LAYER, and
  // this app reaches Total ETO from three of them (instrumentation's hourly pass,
  // a server action's Refresh Data click, and page/route reads) — so the
  // production build carried three complete copies of mssql, verified by three
  // separate server chunks each holding mssql's own "SQL injection warning for
  // param" string.
  //
  // Three copies of mssql, and one globalThis pool cache shared between them, is
  // what broke Parts cost on every manual refresh for five days: mssql decides a
  // parameter's wire type with `switch (type) { case TYPES.DateTime: ... }`, a
  // switch on IDENTITY against its OWN TYPES, so a `sql.DateTime` from copy B
  // bound against a pool from copy A fell through to `default` and died in 15ms
  // with "Validation failed for parameter 'start'". See the long note in
  // lib/totaleto-connection.ts, which is also hardened against this
  // independently — a correctness rule this important should not rest on a
  // bundler setting alone.
  //
  // Externalising them means Node's own require cache holds one instance, which
  // is the guarantee the code needs. `tedious` is named as well as `mssql`: it is
  // where the TYPES that must stay identical actually live.
  serverExternalPackages: ["@azure/msal-node-extensions", "mssql", "tedious"],
  // ── Pin the file-tracing root to THIS app (2026-08-27) ────────────────────
  //
  // This app is its own git repo that happens to sit inside the SDC Tools
  // monorepo's folder, so two lockfiles are visible: its own, and
  // "Centrailized library/package-lock.json" one level up. Next infers a
  // tracing root when it sees more than one, picked the OUTER directory, and
  // wrote a four-line warning into the PM2 error log on every single boot —
  // enough noise to bury a real error, which is the only reason to fix it.
  //
  // `__dirname` is this folder, which is the correct root: nothing this app
  // needs at runtime lives above it (the monorepo root holds the OTHER apps,
  // and this one imports none of them). `__dirname` rather than
  // `import.meta.dirname` because package.json declares no `"type": "module"`,
  // so the config is loaded as CommonJS.
  //
  // Not a no-op even without `output: "standalone"`: the inferred root also
  // decides which files a build traces, so pinning it narrows tracing to this
  // app instead of walking the whole monorepo. Verified with a full production
  // build after the change.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
