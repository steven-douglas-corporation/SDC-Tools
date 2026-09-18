-- ── Feedback: a data-accuracy channel with the context attached ─────────────
--
-- Two things, and they must land together: the table, and the three permission
-- rows that decide who may reach it. Splitting them would deploy a route that
-- every role can see (permissionForPath returns null for an unlisted route, so
-- proxy.ts lets any signed-in user through) or one nobody can.
--
-- MUST be applied in the same deploy as the code that reads it (lib/permissions
-- .ts, lib/feedback-status.ts, the /feedback route) — the same rule
-- 20260901120000 and 20260818150000 both document.
--
-- Nothing here is destructive: one new table, and INSERTs that no-op on a row
-- that already exists.

-- ── 1. The table ────────────────────────────────────────────────────────────
--
-- See the model header in schema.prisma for why the context columns exist at
-- all, why jobId/periodMonth/employeeKey are duplicated out of `params`, and
-- why status/category/severity are VARCHAR rather than ENUM.
CREATE TABLE `feedback` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  `submittedById` INTEGER NULL,
  `submitterEmail` VARCHAR(191) NOT NULL,
  `submitterName` VARCHAR(191) NULL,
  `sourceApp` VARCHAR(32) NOT NULL DEFAULT 'reports',
  `submittedVia` VARCHAR(16) NOT NULL DEFAULT 'ui',

  `routePath` VARCHAR(128) NULL,
  `viewLabel` VARCHAR(64) NULL,
  `params` JSON NULL,
  `contextUrl` VARCHAR(512) NULL,

  `subjectType` VARCHAR(24) NULL,
  `subjectKey` VARCHAR(64) NULL,
  `jobId` VARCHAR(20) NULL,
  `periodMonth` VARCHAR(7) NULL,
  `employeeKey` VARCHAR(32) NULL,

  `fieldLabel` VARCHAR(64) NULL,
  `observedValue` VARCHAR(191) NULL,
  `expectedValue` VARCHAR(191) NULL,
  `body` TEXT NOT NULL,
  `category` VARCHAR(24) NOT NULL DEFAULT 'data-accuracy',
  `severity` VARCHAR(16) NOT NULL DEFAULT 'wrong',

  `status` VARCHAR(16) NOT NULL DEFAULT 'open',
  `assignedToEmail` VARCHAR(191) NULL,
  `acknowledgedAt` DATETIME(3) NULL,
  `resolutionNote` VARCHAR(1000) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `resolvedByEmail` VARCHAR(191) NULL,

  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The default queue — open items, newest first — is the one query this table
-- serves on every page load. The rest each back a filter the grid exposes.
CREATE INDEX `feedback_status_createdAt_idx` ON `feedback`(`status`, `createdAt`);
CREATE INDEX `feedback_jobId_idx` ON `feedback`(`jobId`);
CREATE INDEX `feedback_sourceApp_routePath_idx` ON `feedback`(`sourceApp`, `routePath`);
CREATE INDEX `feedback_submitterEmail_createdAt_idx` ON `feedback`(`submitterEmail`, `createdAt`);
CREATE INDEX `feedback_assignedToEmail_status_idx` ON `feedback`(`assignedToEmail`, `status`);
CREATE INDEX `feedback_periodMonth_idx` ON `feedback`(`periodMonth`);

-- ON DELETE SET NULL, not CASCADE: deleting a user must never delete the
-- reports they filed. submitterEmail is a snapshot precisely so the row stays
-- readable once this FK goes null.
ALTER TABLE `feedback`
  ADD CONSTRAINT `feedback_submittedById_fkey`
  FOREIGN KEY (`submittedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 2. Seed the permission matrix ───────────────────────────────────────────
--
-- SUBMIT is seeded TRUE for every editable role: a data-accuracy channel
-- nobody can reach dies, so the Flag button is on for everyone and the key
-- exists so it can be REVOKED from a role rather than because it starts narrow.
--
-- VIEW and TRIAGE are MANAGER only. The queue is an oversight surface, not a
-- nav item every signed-in user needs, and this is the same shape cash-flow
-- :view took in 20260901120000: seeded OFF for the roles that do not need it,
-- so widening it is a deliberate click on /admin/permissions rather than
-- another migration.
--
-- Note the consequence, which is deliberate: feedback:view is also what lets a
-- SUBMITTER read the response to their own report, so a PM or Sales user can
-- file but not yet see what came of it. One checkbox changes that.
--
-- ELT gets no rows at all — it passes every permission through the wildcard in
-- hasPermission(), and EDITABLE_ROLES deliberately excludes it, so a row here
-- would be one no save could ever reach. Same as every other permission.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'feedback:submit', TRUE, NOW(), 'migration:20260918120000'),
  ('MANAGER', 'feedback:submit', TRUE, NOW(), 'migration:20260918120000'),
  ('PM',      'feedback:submit', TRUE, NOW(), 'migration:20260918120000'),
  ('SALES',   'feedback:submit', TRUE, NOW(), 'migration:20260918120000')
ON DUPLICATE KEY UPDATE `id` = `id`;

-- The queue and the controls on it. The ON DUPLICATE KEY no-op matters most
-- here: if this migration is ever re-applied against a database where somebody
-- has since ticked PM's View box, re-running must not quietly take it away.
INSERT INTO `RolePermission` (`role`, `permission`, `enabled`, `updatedAt`, `updatedByEmail`)
VALUES
  ('ALL',     'feedback:view',   FALSE, NOW(), 'migration:20260918120000'),
  ('MANAGER', 'feedback:view',   TRUE,  NOW(), 'migration:20260918120000'),
  ('PM',      'feedback:view',   FALSE, NOW(), 'migration:20260918120000'),
  ('SALES',   'feedback:view',   FALSE, NOW(), 'migration:20260918120000'),
  ('ALL',     'feedback:triage', FALSE, NOW(), 'migration:20260918120000'),
  ('MANAGER', 'feedback:triage', TRUE,  NOW(), 'migration:20260918120000'),
  ('PM',      'feedback:triage', FALSE, NOW(), 'migration:20260918120000'),
  ('SALES',   'feedback:triage', FALSE, NOW(), 'migration:20260918120000')
ON DUPLICATE KEY UPDATE `id` = `id`;
