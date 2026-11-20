-- SDC Project Tracker: a card records the day its work started.
--
-- A card has always recorded the day it was finished (actual_completion_date). The day it was
-- started was only in the status log, as the time someone first moved it out of To do. That is
-- the time the move was typed in, which is wrong for any work entered after the fact: work
-- recorded today that began in September showed as starting today.
--
-- So the start is a date of its own. It is filled in the first time a card moves into work
-- (any status that is not To do or Cancelled) and can be corrected afterwards, the same as the
-- finish date, so history entered late is still drawn where it happened.
--
-- Cards that exist already take the day of their first such move from the status log, or the
-- day they were finished if that is earlier.

ALTER TABLE tracker.task
    ADD COLUMN actual_start_date date;

UPDATE tracker.task t
   SET actual_start_date = least(s.day, t.actual_completion_date)
  FROM (SELECT l.task_id, min(l.changed_at)::date AS day
          FROM tracker.status_log l
          JOIN tracker.workflow_status w ON w.id = l.to_status_id
         WHERE w.category NOT IN ('todo', 'cancelled')
         GROUP BY l.task_id) s
 WHERE s.task_id = t.id;

UPDATE tracker.task
   SET actual_start_date = actual_completion_date
 WHERE actual_start_date IS NULL AND actual_completion_date IS NOT NULL;
