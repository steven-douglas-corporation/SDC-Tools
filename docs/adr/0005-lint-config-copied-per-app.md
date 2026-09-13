# ADR 0005 — One ESLint rule set, copied into each app and checked for drift

**Status:** Accepted, 2026-09-13

## Context

Five apps are plain JavaScript with no linter; Reports has its own Next.js
ESLint setup with TypeScript. We want one rule set for the JavaScript apps,
enforced in CI, without making the apps depend on each other's `node_modules`.

Each app is its own npm project with its own lockfile, and CI runs `npm ci`
inside the app directory. A config that `import`ed plugins from a sibling
directory (`../../packages/eslint-config`) would resolve them from whichever
`node_modules` Node finds walking up from the config file's *real* path — not
the app's — and lint would behave differently locally and in CI.

## Decision

- The canonical config is `packages/eslint-config/eslint.config.mjs`.
- Each JavaScript app carries a byte-identical copy as `eslint.config.mjs` and
  declares the plugins in its own devDependencies.
- App-specific additions go after a marker line
  (`// ── App-specific overrides below …`), so the canonical block stays
  comparable.
- `scripts/check-lint-configs.mjs` (root `npm run lint:configs`) fails CI when
  a copy drifts and `--fix` re-copies the canonical block while keeping the
  app's overrides.
- Severity: `error` = runtime bug; hygiene = `warn`. CI fails on errors only,
  so the rules could land on legacy code the same day.

## Consequences

- Changing a rule is one edit plus `npm run lint:configs -- --fix` and one PR
  touching every app — deliberate, visible, and reviewed once.
- Reports keeps its Next/TypeScript config; it is a different language and
  framework and already stricter.

## Rejected

- **A published `@sdc/eslint-config` package**: correct in principle, but we
  have no private registry and the repo is public; publishing an internal
  config to npm for five consumers in one repo is more process than value.
- **Root-level lint of everything with one config and one `node_modules`**:
  needs hoisting every app into the root workspace, which ADR 0001 rejected.
