# @sdc/eslint-config (reference copy)

The canonical ESLint flat config for the JavaScript apps in this repo. It is
**copied, not imported** — see the header comment in `eslint.config.mjs` for
why (each app is its own npm project with its own lockfile and `npm ci` in CI,
so a cross-directory import resolves plugins from the wrong `node_modules`).

## Adopting it in an app

1. Copy `eslint.config.mjs` to the app root, byte for byte.
2. Add the devDependencies (versions pinned to what the repo uses today):

   ```bash
   npm install -D eslint@^9 @eslint/js@^9 globals@^15 eslint-plugin-react@^7 eslint-plugin-react-hooks@^5 prettier@^3
   ```

3. Add the scripts:

   ```json
   "lint": "eslint .",
   "lint:fix": "eslint . --fix",
   "format": "prettier --write .",
   "format:check": "prettier --check ."
   ```

4. App-specific additions go **after** the canonical block, below a line that
   reads exactly:

   ```js
   // ── App-specific overrides below ─────────────────────────────────────────
   ```

   and extend the exported constant in place:

   ```js
   config.push({
     files: ["electron/**/*.js"],
     languageOptions: { sourceType: "commonjs" },
   });
   ```

   Anything above the marker must match this file. `npm run lint:configs` at the
   repo root (scripts/check-lint-configs.mjs) fails the build when a copy drifts.

## Severity policy

`error` means "this is a bug at runtime" (undefined names, unreachable code,
duplicate keys). Hygiene and style are `warn`. CI fails on errors only, so the
rule set can land on legacy code without blocking deploys, and warnings are
burned down over time rather than silenced.

## Changing the rules

Edit this file, then re-copy it into every app (`npm run lint:configs -- --fix`
does that) and run each app's `npm run lint`. One change, one PR, every app.
