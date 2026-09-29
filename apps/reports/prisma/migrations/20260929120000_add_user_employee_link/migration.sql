-- AlterTable
-- Links a login to its roster person (see the User.employeeId comment in
-- schema.prisma). Nullable: non-employee accounts stay unlinked. Unique: one
-- login per person. SET NULL on delete so removing a roster row never removes
-- an account.
ALTER TABLE `User` ADD COLUMN `employeeId` INTEGER NULL;

-- CreateIndex
CREATE UNIQUE INDEX `User_employeeId_key` ON `User`(`employeeId`);

-- AddForeignKey
ALTER TABLE `User` ADD CONSTRAINT `User_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `Employee`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
