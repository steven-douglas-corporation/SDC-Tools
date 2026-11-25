-- SDC Project Tracker: an optional kind on each card, and a hierarchy that follows it.
--
-- A card may be given a kind: Epic, Feature, Story, Task, Bug or Issue. Nothing requires one, so
-- a team that wants a plain list of cards never sees the taxonomy.
--
-- Each kind has a level, and a card may sit only under a card of a higher kind (a lower level
-- number): a Feature under an Epic, a Story under a Feature or straight under an Epic, a Task,
-- Bug or Issue under any of those. A card with no kind counts as the lowest level, so it can sit
-- under anything with a kind and nothing can sit under it.
--
-- This replaces the earlier rule that subtasks went one level deep. Because the level must drop
-- at every step down, a loop is impossible and no separate loop check is needed.
--
-- "kind" is separate from task.type (task or milestone), which says whether a card carries effort.
--
-- Every name is schema-qualified, so the functions work whatever the caller's search path is.

CREATE TABLE tracker.work_kind (
    key        text     PRIMARY KEY,
    label      text     NOT NULL UNIQUE,
    level      smallint NOT NULL CHECK (level BETWEEN 1 AND 9),   -- 1 is the top of the hierarchy
    sort_order smallint NOT NULL UNIQUE
);

INSERT INTO tracker.work_kind (key, label, level, sort_order) VALUES
    ('epic',    'Epic',    1, 1),
    ('feature', 'Feature', 2, 2),
    ('story',   'Story',   3, 3),
    ('task',    'Task',    4, 4),
    ('bug',     'Bug',     4, 5),
    ('issue',   'Issue',   4, 6);

ALTER TABLE tracker.task ADD COLUMN kind text REFERENCES tracker.work_kind (key);

-- Changes to a card's kind and to what it sits under are logged like its other tracked fields.
ALTER TYPE tracker.task_tracked_field ADD VALUE 'kind';
ALTER TYPE tracker.task_tracked_field ADD VALUE 'parent';

-- The level a card counts as: its kind's, or the lowest level there is when it has no kind.
CREATE FUNCTION tracker.work_level(p_kind text) RETURNS smallint LANGUAGE sql STABLE AS $$
    SELECT coalesce((SELECT k.level FROM tracker.work_kind k WHERE k.key = p_kind),
                    (SELECT max(k.level) FROM tracker.work_kind k));
$$;

DROP TRIGGER task_one_level_parent ON tracker.task;
DROP FUNCTION tracker.enforce_one_level_parent();

CREATE FUNCTION tracker.enforce_parent_is_higher_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    own_level    smallint := tracker.work_level(NEW.kind);
    parent_level smallint;
BEGIN
    IF NEW.parent_task_id IS NOT NULL THEN
        -- A parent in another project is not found here and is left to the foreign key to refuse.
        SELECT tracker.work_level(p.kind) INTO parent_level
          FROM tracker.task p WHERE p.id = NEW.parent_task_id AND p.project_id = NEW.project_id;
        IF parent_level >= own_level THEN
            RAISE EXCEPTION 'task % cannot sit under task %: its parent must be of a higher kind',
                NEW.id, NEW.parent_task_id USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    -- Changing this card's kind must not leave a card under it at the same level or above.
    IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM tracker.task c
                                     WHERE c.parent_task_id = NEW.id
                                       AND tracker.work_level(c.kind) <= own_level) THEN
        RAISE EXCEPTION 'task % has cards under it that would no longer be of a lower kind', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_parent_is_higher_kind BEFORE INSERT OR UPDATE OF parent_task_id, kind ON tracker.task
    FOR EACH ROW EXECUTE FUNCTION tracker.enforce_parent_is_higher_kind();

-- The list of kinds is reference data: everyone reads it, and only a migration changes it.
GRANT SELECT ON tracker.work_kind TO tracker_service, tracker_engine, tracker_readonly;
GRANT EXECUTE ON FUNCTION tracker.work_level(text) TO tracker_service, tracker_engine, tracker_readonly;
