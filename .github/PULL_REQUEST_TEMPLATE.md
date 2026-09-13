## What changed

<!-- One paragraph. What a reader of `git log` needs to know in a year. -->

## Why

<!-- The problem, bug report, or request this answers. Link the issue if there is one. -->

## Which app(s)

- [ ] Assemblies Library (`apps/assemblies`, :4001)
- [ ] Build Readiness (`apps/build-readiness`, :4002)
- [ ] State Logic Builder (`apps/state-logic`, :4004)
- [ ] Calendar (`apps/calendar`, :4005)
- [ ] Reports (`apps/reports`, :4006)
- [ ] Desktop shell (`apps/shell`) — **a version bump here publishes a public installer**
- [ ] Server updater / pm2 / CI (`scripts/`, `ecosystem.config.js`, `.github/`)
- [ ] Docs only

## How it was verified

<!-- Commands run and their result. "Tests pass" is not enough on its own — say which. -->

- [ ] `npm run lint` clean in every touched app
- [ ] `npm test` green in every touched app
- [ ] Built (`npm run build`) where the app has a build
- [ ] Checked in the browser / desktop, or explained why that was not possible

## Production impact

<!-- Does this need a pm2 restart, a migration, a new env var, a firewall change? Say so, or write "none". -->

## Rollback

<!-- How to undo it if it misbehaves. Usually "revert the commit; the updater redeploys within 5 minutes". -->
