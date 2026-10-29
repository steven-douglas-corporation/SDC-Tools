-- ── Positions created in SDC Reports become hire requests ───────────────────
--
-- A manager asks for a hire here; the recruiter posts it in Paylocity, and the
-- posting reaches the app with the next warehouse load. So a created row is a
-- request, never an opening, and it no longer counts toward any hiring total.
--
-- hiringManagerId: the Paylocity employee id of the team lead who will be the
-- hiring manager on the Paylocity posting. It is what lets a request be matched
-- to the posting it became ("Hiring Managers" on the warehouse view carries the
-- same ids). NULL for rows made before this column.
-- note: anything the recruiter should know when filing it.
--
-- Additive and nullable: existing rows keep every value they have.
ALTER TABLE `HiringPositionCreated`
  ADD COLUMN `hiringManagerId` VARCHAR(32) NULL,
  ADD COLUMN `note` VARCHAR(1000) NULL;
