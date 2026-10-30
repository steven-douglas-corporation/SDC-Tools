-- ── The Hiring tab and "Request a hire" get their own permissions ──────────
--
-- `employees:hiring:view` gates the Employees page's Hiring tab and every hiring
-- figure on that page (employees/page.tsx doesn't read positions without it).
-- `employees:hiring:request` gates "+ Request a hire" and createHiringRequest,
-- which until now rode on `employees:hiring:assign`.
--
-- Seeded so nobody's access moves on deploy: view copies each role's current
-- `employees:view` (the tab was shown to everyone who could open the page),
-- request copies `employees:hiring:assign`. ELT is left out: it passes every
-- permission through the wildcard in hasPermission().
--
-- MUST be applied in the SAME deploy as the code that reads it (lib/permissions.ts,
-- lib/permission-catalog.ts, employees/page.tsx, lib/hiring-actions.ts), never
-- before. Auto-deploy runs `prisma migrate deploy` ahead of the build.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT src.`role`, 'employees:hiring:view', src.`enabled`, NOW(), 'migration:20261030140000'
  FROM (SELECT `role`, `enabled` FROM `RolePermission` WHERE `permission` = 'employees:view' AND `role` <> 'ELT') AS src
ON DUPLICATE KEY UPDATE `updatedAt` = `RolePermission`.`updatedAt`;

INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
SELECT src.`role`, 'employees:hiring:request', src.`enabled`, NOW(), 'migration:20261030140000'
  FROM (SELECT `role`, `enabled` FROM `RolePermission` WHERE `permission` = 'employees:hiring:assign' AND `role` <> 'ELT') AS src
ON DUPLICATE KEY UPDATE `updatedAt` = `RolePermission`.`updatedAt`;
