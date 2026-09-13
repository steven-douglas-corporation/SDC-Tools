# Branch protection for `master`

These are GitHub repository settings, not files, so they cannot be committed.
Apply them once at
https://github.com/steven-douglas-corporation/SDC-Tools/settings/branches
(add a rule for `master`) and tick them off here.

Why it matters more than usual here: the server updater deploys `master`
within five minutes of any push. A rule that keeps unreviewed or unbuilt code
off `master` is a rule that keeps it off production.

## Rule for `master`

- [ ] **Require a pull request before merging** — 1 approval.
- [ ] **Dismiss stale approvals when new commits are pushed.**
- [ ] **Require review from Code Owners** (`.github/CODEOWNERS`).
- [ ] **Require status checks to pass before merging**, and **require branches
      to be up to date**. Required checks, from `.github/workflows/ci.yml`:
  - `Lint configs`
  - `Assemblies Library`
  - `Build Readiness`
  - `Calendar`
  - `State Logic Builder`
  - `Shell`
  - `Reports`
- [ ] **Require conversation resolution before merging.**
- [ ] **Require linear history** (squash or rebase merges only). Keeps the
      updater's `git diff HEAD origin/master` list small and readable.
- [ ] **Do not allow bypassing the above settings** — administrators included.
      The one exception is a production incident; use the admin override, then
      open the PR after.
- [ ] **Block force pushes** and **block deletions**.

## Repository settings that go with it

- [ ] Settings → General → Pull Requests: allow **squash merging** only, with
      the PR title as the default commit message.
- [ ] Settings → General: **automatically delete head branches**.
- [ ] Settings → Actions → General: **Read and write** workflow permissions are
      needed by `release.yml` to create Releases (it declares
      `permissions: contents: write`; the repo default must not be more
      restrictive).
- [ ] Settings → Secrets and variables → Actions: `AZURE_TENANT_ID`,
      `AZURE_CLIENT_ID`, and `SDC_SERVER_HOST` for the shell build.
- [ ] Settings → Code security: enable **Dependabot alerts**, **Dependabot
      security updates**, and **secret scanning** with **push protection**.

## Why linear history

`scripts/sdc-main-updater.js` decides what to rebuild from the list of files
that differ between the server's HEAD and `origin/master`, and it refuses to
update when local HEAD is not an ancestor of the remote. Merge commits and
force pushes are exactly the two things that make that ancestry check
ambiguous.
