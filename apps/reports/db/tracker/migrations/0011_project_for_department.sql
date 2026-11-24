-- SDC Project Tracker: a project says which department it is for.
--
-- "For" is the department that benefits: the one whose work gets easier, faster or cheaper.
-- It is not who does the work, which can be read from who the cards are assigned to.
--
-- The departments are not a list kept here. They are the company's own teams, copied in from
-- the employee roster each time a tracker page is opened (service/departments.ts), and
-- arranged in two levels the way the org chart arranges them: a group (Engineering) with the
-- teams under it (Mechanical Engineering, Controls Engineering). A project is for a whole
-- group, for one team, or for the company as a whole.
--
-- tracker.team has been here since 0001 as "where a person sits", empty and flat. It becomes
-- that two-level list: one table of org units, so that a person's team and a project's
-- department are the same rows.
--
--   code            the roster's own code for the team (mech, controls, ...), which is what
--                   the copy matches on, so a team can be renamed without losing its projects
--   parent_team_id  the group a team sits under; null for a group, or for a team with none
--   active          false once the roster no longer has the team. Kept, never deleted, so a
--                   project that was for it still says so.
--
-- Projects that exist already have no department. As with the justification in 0010, the
-- rule is enforced where a project is created or made active, not by a constraint.

ALTER TABLE tracker.team
    ADD COLUMN code           text UNIQUE,
    ADD COLUMN parent_team_id bigint REFERENCES tracker.team(id),
    ADD COLUMN sort_order     integer NOT NULL DEFAULT 0,
    ADD COLUMN active         boolean NOT NULL DEFAULT true;

ALTER TABLE tracker.project
    ADD COLUMN for_team_id bigint REFERENCES tracker.team(id);
CREATE INDEX project_for_team ON tracker.project (for_team_id) WHERE for_team_id IS NOT NULL;

ALTER TYPE tracker.project_tracked_field ADD VALUE IF NOT EXISTS 'for_department';
