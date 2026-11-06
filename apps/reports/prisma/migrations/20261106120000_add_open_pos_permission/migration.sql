-- ── Open POs gets its own permission ─────────────────────────────────────────
--
-- New page /open-pos (procurement / supply chain). Seeded to match job-hour-details:view,
-- role by role, from the LIVE table: Job Details > Procurement already shows those roles the
-- same purchase-order money, so nobody gains or loses anything on deploy. Narrowing it is a
-- tick on /admin/permissions.
--
-- MUST ship in the SAME deploy as the code that reads it (lib/permissions.ts,
-- route-permissions.ts). Auto-deploy runs `prisma migrate deploy` ahead of the build, so a
-- merge does that. Nothing here is destructive: no existing row is modified.
--
-- Same shape as 20261021130000_add_data_management_permission: the source is aliased and the
-- target's `id` qualified, because an unqualified `id` is ambiguous (MySQL 1052).
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT src.`role`, 'open-pos:view', src.`enabled`, NOW(), 'migration:20261106120000'
FROM `RolePermission` AS src
WHERE src.`permission` = 'job-hour-details:view' AND src.`role` <> 'ELT'
ON DUPLICATE KEY UPDATE `RolePermission`.`id` = `RolePermission`.`id`;

-- An explicit OFF for any editable role that had no job-hour-details:view row, so the matrix
-- has a row per (role, permission) like every other permission. The no-op ON DUPLICATE KEY
-- keeps what the first statement copied.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'open-pos:view', FALSE, NOW(), 'migration:20261106120000'),
  ('MANAGER', 'open-pos:view', FALSE, NOW(), 'migration:20261106120000'),
  ('PM',      'open-pos:view', FALSE, NOW(), 'migration:20261106120000'),
  ('SALES',   'open-pos:view', FALSE, NOW(), 'migration:20261106120000')
ON DUPLICATE KEY UPDATE `id` = `id`;
