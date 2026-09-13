// ─────────────────────────────────────────────────────────────────────────────
// SDC Tools — canonical ESLint flat config for the JavaScript apps.
//
// Every JavaScript app (apps/assemblies, apps/build-readiness, apps/calendar,
// apps/shell, apps/state-logic) carries a BYTE-IDENTICAL copy of this file as
// its own `eslint.config.mjs`, plus the devDependencies listed in README.md.
// `npm run lint:configs` at the repo root fails if any copy has drifted.
//
// Why a copy per app rather than one shared import: each app is its own npm
// project with its own lockfile, and CI runs `npm ci` per app. A config that
// imported plugins from a sibling directory would resolve them from the WRONG
// node_modules (Node resolves through the real path of a symlink), and the
// lint step would pass locally and fail in CI — or the reverse.
//
// Severity policy: `error` is reserved for things that are bugs at runtime
// (undefined names, unreachable code, duplicate keys). Style and hygiene are
// `warn`, so adopting the rule set on legacy code does not block a deploy —
// warnings are visible in the lint output and are burned down over time.
//
// `config` is a named constant and the default export is that binding, so an
// app can extend it AFTER the canonical block with `config.push({ ... })` —
// a closed `export default [...]` cannot be reached from anything written
// below it (found by the first two adopters, 2026-09-13).
// ─────────────────────────────────────────────────────────────────────────────
import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

const config = [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/build/**",
      "**/out/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/*.min.js",
      // Vendored third-party bundles kept verbatim.
      "**/frontend/react.js",
      "**/frontend/react-dom.js",
      "**/frontend/babel.min.js",
      "**/frontend/xlsx.full.min.js",
    ],
  },
  js.configs.recommended,
  // ── Node (servers, Electron main process, scripts) ────────────────────────
  {
    files: ["**/*.{js,cjs,mjs}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.es2024 },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-console": "off",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs" },
  },
  // ── Browser + React (Vite clients, legacy in-browser JSX) ─────────────────
  {
    files: ["**/*.jsx", "**/client/**/*.js", "**/src/**/*.js", "**/frontend/**/*.js", "**/renderer/**/*.js"],
    plugins: { react, "react-hooks": reactHooks },
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.es2024 },
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Not using PropTypes; TypeScript is the long-term answer, not runtime checks.
      "react/prop-types": "off",
      // The automatic JSX runtime (Vite) and the in-browser Babel preset both
      // provide React without an import.
      "react/react-in-jsx-scope": "off",
      "react/no-unescaped-entities": "off",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      eqeqeq: ["warn", "smart"],
    },
  },
  // ── Tests ─────────────────────────────────────────────────────────────────
  {
    files: ["**/tests/**", "**/*.test.{js,mjs,cjs,jsx}", "**/*.spec.{js,mjs,cjs,jsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser, ...globals.vitest, ...globals.mocha },
    },
  },
];

export default config;
// ── App-specific overrides below ─────────────────────────────────────────

// "Target design/" is the original browser-Babel design mock-up (gitignored,
// shares components and data as window globals across <script> tags). It is
// reference material, not shipped code, and is not part of the Vite build.
config.push({ ignores: ['Target design/**'] });
