-- ── The Project Tracker module gets its two permissions ──────────────────────
--
-- New route /tracker, the first module added to this app (docs/MODULES.md).
-- tracker:view opens it; tracker:edit allows creating and changing projects and tasks.
--
-- Both are seeded OFF for every editable role, so on deploy nobody but ELT (the wildcard in
-- lib/permissions.ts) sees the tracker or its sidebar entry. Opening it to a pilot role is a
-- tick on /admin/permissions, not a code change.
--
-- MUST ship in the SAME deploy as the code that reads it (lib/permissions.ts,
-- route-permissions.ts). Nothing here is destructive: no existing row is modified.
--
-- An explicit row per (role, permission), like every other permission, so the matrix has no
-- gaps. The no-op ON DUPLICATE KEY makes this safe to re-run.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'tracker:view', FALSE, NOW(), 'migration:20261115120000'),
  ('MANAGER', 'tracker:view', FALSE, NOW(), 'migration:20261115120000'),
  ('PM',      'tracker:view', FALSE, NOW(), 'migration:20261115120000'),
  ('SALES',   'tracker:view', FALSE, NOW(), 'migration:20261115120000'),
  ('ALL',     'tracker:edit', FALSE, NOW(), 'migration:20261115120000'),
  ('MANAGER', 'tracker:edit', FALSE, NOW(), 'migration:20261115120000'),
  ('PM',      'tracker:edit', FALSE, NOW(), 'migration:20261115120000'),
  ('SALES',   'tracker:edit', FALSE, NOW(), 'migration:20261115120000')
ON DUPLICATE KEY UPDATE `id` = `id`;
