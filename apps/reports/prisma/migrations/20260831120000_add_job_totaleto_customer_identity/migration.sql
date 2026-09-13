-- Customer identity as TotalETO knows it, so customers can be grouped by a
-- stable source identifier rather than by the spelling somebody typed.
--
-- `totEtoAccountId` is tblCompany.CAccCustomerID -- the accounting customer
-- ACCOUNT -- and it is the column that matters: TotalETO itself holds five
-- duplicate company records for First Solar's US parent (#528, #1616, #1618,
-- #1619, #1625) plus one per site, all of which carry account 'First Solar',
-- while First Solar India / Sweden / Malaysia carry their own. `totEtoCompanyId`
-- is kept alongside it for traceability and for the handful of customers that
-- have no account id at all (TotalETO #1, Steven Douglas Corp., is one).
--
-- Both NULL-able with no default, on purpose: a job TotalETO has no project for
-- (the internal 4000 / 7000 / 10000-series, 8 of the 59 active jobs today) has
-- no company and no account, and a DEFAULT would turn "not applicable" into a
-- claimed value. Every existing row reads NULL until syncFromTotalEto or
-- scripts/backfill-customer-identity.ts fills it in; lib/customer-canonical.ts
-- falls back to name rules for as long as that is the case.
ALTER TABLE `Job`
  ADD COLUMN `totEtoCompanyId` INTEGER NULL,
  ADD COLUMN `totEtoAccountId` VARCHAR(191) NULL;

-- The chart groups ~60 active jobs in memory, so this index is not for the
-- Dashboard; it is so a future query CAN filter by account without a table scan.
CREATE INDEX `Job_totEtoAccountId_idx` ON `Job`(`totEtoAccountId`);
