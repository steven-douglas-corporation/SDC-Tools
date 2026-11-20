-- SDC Project Tracker: a project records the day it started.
--
-- A card has a start date (0013), and a project's start was taken to be the earliest among its
-- cards. That leaves a project that began before it was entered here with no way to say so:
-- its cards are the work still to do, and none of them has started.
--
-- So a project can carry its own start date, set by a manager. It is optional. Where it is
-- set it is the day the timeline draws the project from, or the earliest card if that is
-- earlier still; where it is not, the cards decide as before.

ALTER TABLE tracker.project
    ADD COLUMN actual_start_date date;

ALTER TYPE tracker.project_tracked_field ADD VALUE IF NOT EXISTS 'start_date';
