# Security

SDC Tools is internal software for Stevens Douglas Corporation. It is not
offered to the public, but the repository is public, so the rules below apply
to everyone who works in it.

## Reporting a problem

Email **akamuju@sdcautomation.com** with the app, the page or endpoint, what you
did, and what you saw. Do not open a public issue for anything that could be a
vulnerability. You will get an acknowledgement within one business day.

## What must never be committed

- `.env` files, or any value that belongs in one: database passwords, the
  Total ETO SQL login, Smartsheet and Azure credentials, `SDC_SESSION_SECRET`,
  the Scheduler shared token, Power BI tokens. `.gitignore` blocks `.env` in
  every directory; `.env.example` files document the shape with placeholders.
- Database files (`*.db`, `*.sqlite`), backups, or exports containing employee
  or customer data.
- Installers or binaries (`*.exe`, `*.pbix`) other than the tracked Power BI
  report definition files.

If a secret is committed by mistake, rotate it first, then remove it from
history second. A rotated secret in history is a nuisance; an un-rotated one is
a breach.

## How the apps authenticate

- The desktop shell signs users in with Azure AD (MSAL) and holds the session.
- Reports (`apps/reports`) uses NextAuth with per-route permission checks on
  every server action; see `assertActionPermission`.
- Scheduler, Assemblies, Build Readiness, State Logic and Calendar share the
  `sdc_session` cookie minted by the Scheduler (`SDC_SSO_ENABLED`); the verifier
  is duplicated per app on purpose until it is extracted to `packages/`.

## Dependencies

Dependabot opens grouped weekly pull requests per app and immediate pull
requests for advisories (`.github/dependabot.yml`). CI must pass before they
merge; the server updater deploys master within five minutes of a merge.
