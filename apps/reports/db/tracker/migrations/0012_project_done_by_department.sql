-- SDC Project Tracker: a project says which department does the work.
--
-- 0011 gave a project the department it is for: the one that benefits. This is the other
-- half: the department that carries the project out. The two often differ (the AI team
-- builds something for Controls Engineering), and both are needed to see how much one
-- department is being asked to do and how much is being done for it.
--
-- 0011 expected this to be read from who the cards are assigned to. That only works once
-- cards are assigned and every account is tied to an employee, and a project needs an
-- answer before either is true, so it is asked for outright.
--
-- It is one of the same departments (tracker.team), chosen the same way. Projects that exist
-- already have none; as with the others, the rule is enforced where a project is created or
-- made active, not by a constraint.

ALTER TABLE tracker.project
    ADD COLUMN done_by_team_id bigint REFERENCES tracker.team(id);
CREATE INDEX project_done_by_team ON tracker.project (done_by_team_id) WHERE done_by_team_id IS NOT NULL;

ALTER TYPE tracker.project_tracked_field ADD VALUE IF NOT EXISTS 'done_by_department';
