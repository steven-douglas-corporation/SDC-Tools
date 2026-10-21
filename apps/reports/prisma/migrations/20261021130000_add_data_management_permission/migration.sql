-- ── Data Management gets its own permission ─────────────────────────────────
--
-- Admin > Data Management was gated on dashboard:view, so showing it to a role meant
-- handing that role the whole Dashboard with it. `data-management:view` is its own row on
-- the Role Permissions page now.
--
-- MUST be applied in the SAME deploy as the code that reads it (lib/permissions.ts,
-- route-permissions.ts, data-quality-actions.ts), never before. Auto-deploy runs
-- `prisma migrate deploy` ahead of the build, so a merge does that. Nothing here is
-- destructive: no existing row is modified.

-- ── 1. Copy dashboard:view, role by role ─────────────────────────────────────
--
-- Not a hard-coded list of roles. The live table is the truth about who can open the page
-- today (an ELT user may have ticked or cleared dashboard:view since the defaults in
-- lib/permissions.ts were written), so the new row starts out equal to it and nobody gains
-- or loses the page on deploy. ELT is left out: it passes every permission through the
-- wildcard in hasPermission(), and no save can reach an ELT row.
--
-- The table is both the target and the source, so the source is aliased and the target's `id`
-- is qualified: an unqualified `id` in ON DUPLICATE KEY UPDATE is "ambiguous" (MySQL 1052).
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT src.`role`, 'data-management:view', src.`enabled`, NOW(), 'migration:20261021130000'
FROM `RolePermission` AS src
WHERE src.`permission` = 'dashboard:view' AND src.`role` <> 'ELT'
ON DUPLICATE KEY UPDATE `RolePermission`.`id` = `RolePermission`.`id`;

-- ── 2. An explicit OFF for any editable role that had no dashboard:view row ──
--
-- A missing row already reads as off, but the matrix draws a row per (role, permission) and
-- an explicit one is what every other permission has. The ON DUPLICATE KEY no-op matters:
-- it must not overwrite what step 1 just copied, and re-running this migration against a
-- database where somebody has since ticked a box must not quietly take it away.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'data-management:view', FALSE, NOW(), 'migration:20261021130000'),
  ('MANAGER', 'data-management:view', FALSE, NOW(), 'migration:20261021130000'),
  ('PM',      'data-management:view', FALSE, NOW(), 'migration:20261021130000'),
  ('SALES',   'data-management:view', FALSE, NOW(), 'migration:20261021130000')
ON DUPLICATE KEY UPDATE `id` = `id`;
