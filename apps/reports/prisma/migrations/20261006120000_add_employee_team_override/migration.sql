-- AlterTable
-- A team set by hand for one person (see the Employee.teamOverride comment in
-- schema.prisma). Nullable: null means "automatic", the team follows the
-- reporting line. Additive; nothing existing changes.
ALTER TABLE `Employee` ADD COLUMN `teamOverride` VARCHAR(191) NULL;
