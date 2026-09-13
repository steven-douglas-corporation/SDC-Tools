import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Server actions receive FormData they don't always need; the `_` prefix
      // marks those as deliberately unused.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // The other .next-* dist dirs this project's own tooling creates (dev:preview*,
    // the sdc-etc-planner-verify*/-perf/-buildcheck launch configs, all via
    // NEXT_DIST_DIR) — eslint-config-next's default only covers the literal `.next`,
    // so any of these left on disk got scanned as source, not generated output.
    ".next-*/**",
    // Design-tool mockup exports dropped for reference (gitignored, not app code —
    // see .gitignore's own comment on this).
    "reference/**",
  ]),
]);

export default eslintConfig;
