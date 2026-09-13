-- CreateTable
CREATE TABLE `RolePermission` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `role` ENUM('ALL', 'MANAGER', 'SALES', 'ELT') NOT NULL,
  `permission` VARCHAR(64) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `updatedAt` DATETIME(3) NOT NULL,
  `updatedByEmail` VARCHAR(191) NULL,

  UNIQUE INDEX `RolePermission_role_permission_key`(`role`, `permission`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- Seed: matches lib/permissions.ts's DEFAULT_OWN_PERMISSIONS exactly, flattened
-- to the CUMULATIVE set each role actually has (not just what that tier adds on
-- top of the one below) — turning this feature on must not change anyone's
-- access on day one. ELT is deliberately NOT seeded here: ELT's access comes
-- from hasPermission()'s wildcard, never from this table, so there is no row
-- for the Role Permissions UI to read for that column — it's drawn as
-- permanently checked instead. See role-permissions-store.ts / the admin page.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`) VALUES
  -- ALL — the three base grants
  ('ALL', 'job-hour-details:view', true, NOW(3)),
  ('ALL', 'job-hour-details:schedule', true, NOW(3)),
  ('ALL', 'build-readiness:view', true, NOW(3)),
  ('ALL', 'projects:view', false, NOW(3)),
  ('ALL', 'projects:edit', false, NOW(3)),
  ('ALL', 'monthly-etc:view', false, NOW(3)),
  ('ALL', 'hours:view', false, NOW(3)),
  ('ALL', 'dashboard:view', false, NOW(3)),
  ('ALL', 'standards:view', false, NOW(3)),
  ('ALL', 'standards:edit', false, NOW(3)),
  ('ALL', 'standards:pm', false, NOW(3)),
  ('ALL', 'standards:mfg', false, NOW(3)),
  ('ALL', 'standards:warranty', false, NOW(3)),
  ('ALL', 'employees:view', false, NOW(3)),
  ('ALL', 'employees:edit', false, NOW(3)),
  ('ALL', 'audit-log:view', false, NOW(3)),
  ('ALL', 'profitability:view', false, NOW(3)),
  ('ALL', 'users:manage', false, NOW(3)),
  ('ALL', 'permissions:manage', false, NOW(3)),
  -- MANAGER — ALL's three, plus its own five
  ('MANAGER', 'job-hour-details:view', true, NOW(3)),
  ('MANAGER', 'job-hour-details:schedule', true, NOW(3)),
  ('MANAGER', 'build-readiness:view', true, NOW(3)),
  ('MANAGER', 'projects:view', true, NOW(3)),
  ('MANAGER', 'projects:edit', false, NOW(3)),
  ('MANAGER', 'monthly-etc:view', true, NOW(3)),
  ('MANAGER', 'hours:view', true, NOW(3)),
  ('MANAGER', 'dashboard:view', true, NOW(3)),
  ('MANAGER', 'standards:view', false, NOW(3)),
  ('MANAGER', 'standards:edit', false, NOW(3)),
  ('MANAGER', 'standards:pm', false, NOW(3)),
  ('MANAGER', 'standards:mfg', false, NOW(3)),
  ('MANAGER', 'standards:warranty', false, NOW(3)),
  ('MANAGER', 'employees:view', true, NOW(3)),
  ('MANAGER', 'employees:edit', false, NOW(3)),
  ('MANAGER', 'audit-log:view', false, NOW(3)),
  ('MANAGER', 'profitability:view', false, NOW(3)),
  ('MANAGER', 'users:manage', false, NOW(3)),
  ('MANAGER', 'permissions:manage', false, NOW(3)),
  -- SALES — MANAGER's eight, plus its own seven
  ('SALES', 'job-hour-details:view', true, NOW(3)),
  ('SALES', 'job-hour-details:schedule', true, NOW(3)),
  ('SALES', 'build-readiness:view', true, NOW(3)),
  ('SALES', 'projects:view', true, NOW(3)),
  ('SALES', 'projects:edit', true, NOW(3)),
  ('SALES', 'monthly-etc:view', true, NOW(3)),
  ('SALES', 'hours:view', true, NOW(3)),
  ('SALES', 'dashboard:view', true, NOW(3)),
  ('SALES', 'standards:view', true, NOW(3)),
  ('SALES', 'standards:edit', true, NOW(3)),
  ('SALES', 'standards:pm', true, NOW(3)),
  ('SALES', 'standards:mfg', true, NOW(3)),
  ('SALES', 'standards:warranty', true, NOW(3)),
  ('SALES', 'employees:view', true, NOW(3)),
  ('SALES', 'employees:edit', false, NOW(3)),
  ('SALES', 'audit-log:view', false, NOW(3)),
  ('SALES', 'profitability:view', true, NOW(3)),
  ('SALES', 'users:manage', false, NOW(3)),
  ('SALES', 'permissions:manage', false, NOW(3));
