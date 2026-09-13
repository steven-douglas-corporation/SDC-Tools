-- ── PM role, no hierarchy, and Monthly ETC split into View/Edit/Submit ──────
--
-- Three things at once, because they only make sense together: PM is a new
-- column in the Role Permissions matrix, that matrix stopped inheriting on the
-- same deploy, and PM's whole reason for existing is Monthly ETC — which was a
-- single all-or-nothing permission until now.
--
-- MUST be applied in the SAME deploy as the code that reads it (lib/permissions
-- .ts, role-permissions-store.ts, the matrix component), never before — the
-- same rule the 20260818150000 role migration documents. Nothing here is
-- destructive: no existing row's `enabled` value is modified, and no existing
-- user's role is changed.

-- ── 1. Widen both Role enum columns ─────────────────────────────────────────
--
-- Both, not just User: RolePermission.role is the same Prisma `Role` enum, and
-- an INSERT of a 'PM' row below would be silently coerced to '' (or rejected
-- under STRICT mode) against the old definition. The 20260818150000 migration
-- altered only User because RolePermission did not exist yet.
--
-- Purely additive, so there is no widen-then-narrow dance to do here: every
-- existing value stays valid at every step.
ALTER TABLE `User` MODIFY `role` ENUM('ALL', 'MANAGER', 'PM', 'SALES', 'ELT') NOT NULL DEFAULT 'ALL';
ALTER TABLE `RolePermission` MODIFY `role` ENUM('ALL', 'MANAGER', 'PM', 'SALES', 'ELT') NOT NULL;

-- ── 2. Flatten inheritance into explicit rows ───────────────────────────────
--
-- hasPermission() used to grant `role` anything held by a LOWER-ranked role
-- (ALL < MANAGER < SALES). It no longer walks that chain, so any permission a
-- role held only by inheritance would silently disappear on deploy. This makes
-- every inherited grant explicit FIRST, so effective access is identical before
-- and after.
--
-- Measured on the live table 2026-09-01: every column was already monotonic, so
-- this statement matched 0 rows. It is here because it must be correct for
-- whatever the table holds when it is actually applied, not for what it held
-- when it was written.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT `target`.`role`, `src`.`permission`, TRUE, NOW(), 'migration:20260901120000'
FROM (
  SELECT 'MANAGER' AS `role`, 1 AS `rank` UNION ALL
  SELECT 'SALES', 2
) AS `target`
JOIN (
  SELECT `permission`, MIN(CASE `role` WHEN 'ALL' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END) AS `rank`
  FROM `RolePermission`
  WHERE `enabled` = TRUE AND `role` IN ('ALL', 'MANAGER', 'SALES')
  GROUP BY `permission`
) AS `src` ON `src`.`rank` < `target`.`rank`
ON DUPLICATE KEY UPDATE `enabled` = TRUE, `updatedAt` = NOW(), `updatedByEmail` = 'migration:20260901120000';

-- ── 3. Monthly ETC — Edit and Submit ────────────────────────────────────────
--
-- Both are NEW keys, and before them there was no check at all: anyone who
-- could open /etc could type in the grid, and submission was gated only by the
-- Standard Sheet password (lib/monthly-report-actions.ts). Seeded ON for every
-- role that already holds monthly-etc:view so splitting the permission apart
-- takes nothing away from anyone who has it today.
--
-- ⚠️  This is preservation, not a recommendation. If ETC submission should be
-- narrower than "everyone who can see the page" — likely, since that currently
-- includes the ALL role — untick it per role on the Role Permissions page.
-- That is a deliberate decision for a person to make, not something a
-- refactoring migration should quietly impose.
-- ⚠️  Both statements read the table they insert into, so the source is wrapped
-- in a derived table (`AS src`) and the ON DUPLICATE clause names a column that
-- exists ONLY in the target. The first attempt at this migration wrote
-- `ON DUPLICATE KEY UPDATE RolePermission.updatedAt = ...` while also selecting
-- FROM RolePermission, and MySQL rejected it as ambiguous (error 1052,
-- 2026-09-01). The second attempt tried `INSERT INTO ... AS tgt`, which is
-- PostgreSQL syntax — MySQL only allows a row alias after VALUES, so that was a
-- 1064 syntax error.
--
-- `id` = `id` is the MySQL idiom for "row exists, leave it completely alone".
-- `id` is unambiguous here because the derived table selects only role and
-- enabled, and it is deliberately a no-op — not even updatedAt moves, so
-- re-running this migration cannot rewrite a value somebody has since changed
-- by hand on the Role Permissions page.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT `src`.`role`, 'monthly-etc:edit', `src`.`enabled`, NOW(), 'migration:20260901120000'
FROM (SELECT `role`, `enabled` FROM `RolePermission` WHERE `permission` = 'monthly-etc:view') AS `src`
ON DUPLICATE KEY UPDATE `id` = `id`;

INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT `src`.`role`, 'monthly-etc:submit', `src`.`enabled`, NOW(), 'migration:20260901120000'
FROM (SELECT `role`, `enabled` FROM `RolePermission` WHERE `permission` = 'monthly-etc:view') AS `src`
ON DUPLICATE KEY UPDATE `id` = `id`;

-- ── 4. Cash Flow Forecast becomes a real row ────────────────────────────────
--
-- Was hard-coded ELT-only in lib/cash-flow-access.ts and deliberately NOT a
-- matrix row. It is a row now, seeded OFF for every editable role, so behavior
-- is byte-for-byte what it was (ELT still passes via the wildcard) and granting
-- it is a click rather than a code change.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'cash-flow:view', FALSE, NOW(), 'migration:20260901120000'),
  ('MANAGER', 'cash-flow:view', FALSE, NOW(), 'migration:20260901120000'),
  ('PM',      'cash-flow:view', FALSE, NOW(), 'migration:20260901120000'),
  ('SALES',   'cash-flow:view', FALSE, NOW(), 'migration:20260901120000')
ON DUPLICATE KEY UPDATE `id` = `id`;

-- ── 5. Seed PM ──────────────────────────────────────────────────────────────
--
-- Explicit, and explicitly NOT copied from MANAGER or SALES — the request was
-- that PM must not inherit either one's list. These eight rows are the set
-- named there: Monthly ETC (view + edit), Projects, Job Hour Details, Build
-- Readiness, plus the two execution views those are read alongside.
--
-- Everything NOT listed is written FALSE rather than left absent, so the matrix
-- renders PM as a full column of real unticked boxes instead of blanks, and so
-- a later `SELECT ... WHERE role='PM'` is complete. Withheld on purpose, each
-- one checkbox away: monthly-etc:submit, projects:edit, standards:*,
-- profitability, tm, cash-flow, and every Administration key.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('PM', 'job-hour-details:view',     TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'job-hour-details:schedule', TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'build-readiness:view',      TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'monthly-etc:view',          TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'monthly-etc:edit',          TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'projects:view',             TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'dashboard:view',            TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'hours:view',                TRUE,  NOW(), 'migration:20260901120000'),
  ('PM', 'monthly-etc:submit',        FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'projects:edit',             FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'standards:view',            FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'standards:edit',            FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'standards:pm',              FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'standards:mfg',             FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'standards:warranty',        FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'profitability:view',        FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'tm:view',                   FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'employees:view',            FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'employees:edit',            FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'employees:hiring:assign',   FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'audit-log:view',            FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'users:manage',              FALSE, NOW(), 'migration:20260901120000'),
  ('PM', 'permissions:manage',        FALSE, NOW(), 'migration:20260901120000')
ON DUPLICATE KEY UPDATE `id` = `id`;
