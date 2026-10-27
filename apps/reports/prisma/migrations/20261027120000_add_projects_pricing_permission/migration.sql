-- ── Sales Price / Change Quote / Total get their own view permission ───────
--
-- Those three Projects-grid columns are now gated behind `projects:pricing`
-- (lib/permissions.ts, quoted/page.tsx) instead of riding on `projects:view` —
-- by request, only Sales and ELT should see what a job sold for. A new row,
-- seeded ON for SALES and OFF for every other editable role, so access
-- changes on deploy exactly the way the request asked rather than by accident
-- of whatever projects:view already held. ELT is left out: it passes every
-- permission through the wildcard in hasPermission(), and no save can reach
-- an ELT row.
--
-- MUST be applied in the SAME deploy as the code that reads it (lib/permissions.ts,
-- lib/permission-catalog.ts, quoted/page.tsx), never before. Auto-deploy runs
-- `prisma migrate deploy` ahead of the build, so a merge does that.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'projects:pricing', FALSE, NOW(), 'migration:20261027120000'),
  ('MANAGER', 'projects:pricing', FALSE, NOW(), 'migration:20261027120000'),
  ('PM',      'projects:pricing', FALSE, NOW(), 'migration:20261027120000'),
  ('SALES',   'projects:pricing', TRUE,  NOW(), 'migration:20261027120000')
ON DUPLICATE KEY UPDATE `id` = `id`;
