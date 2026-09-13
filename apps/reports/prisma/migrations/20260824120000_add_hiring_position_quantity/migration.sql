-- Hiring positions: one requisition can represent several openings (2026-08-24)
--
-- `quantity` is how many openings were asked for; `filledCount` is how many
-- have been hired against the position so far. quantity - filledCount is what
-- still counts toward Open Positions, Planned Headcount and Hiring Capacity
-- hours (see lib/hiring-positions.ts's remainingQuantity).
--
-- Both columns are NOT NULL with defaults, which is what makes this safe to
-- apply to a live table: every existing row immediately reads as exactly "one
-- unfilled opening", identical to its behaviour before this migration, so no
-- headcount or capacity figure moves the moment the columns appear. That is the
-- request's "existing hiring positions without a quantity value must safely
-- default to 1".
--
-- Applied to BOTH sources. HiringPositionCreated owns its rows outright.
-- HiringPositionAssignment is the local overlay on the read-only Paylocity
-- workbook, which is why quantity has to live there for a workbook-sourced
-- position — the workbook itself cannot be written to (see the model's own
-- comment in schema.prisma). Note the deliberate consequence: this app's open
-- position count can now differ from Paylocity's own row count.

ALTER TABLE `HiringPositionCreated`
  ADD COLUMN `quantity` INT NOT NULL DEFAULT 1,
  ADD COLUMN `filledCount` INT NOT NULL DEFAULT 0;

ALTER TABLE `HiringPositionAssignment`
  ADD COLUMN `quantity` INT NOT NULL DEFAULT 1,
  ADD COLUMN `filledCount` INT NOT NULL DEFAULT 0;
