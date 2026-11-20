-- SDC Project Tracker: every card has a kind, and Milestone is one of them.
--
-- 0003 let a card have no kind, and treated such a card exactly like a Task. That gave one thing
-- two names. Now every card has a kind, Task unless something else is chosen, so a team that
-- never opens the menu simply has a board of Tasks.
--
-- A milestone was marked only by task.type. It is now also a kind, at the bottom level, so there
-- is one menu and not two. task.type stays, because the views and the forecast read it, and a
-- trigger keeps the two in step: a card is of type 'milestone' exactly when its kind is.

INSERT INTO tracker.work_kind (key, label, level, sort_order) VALUES ('milestone', 'Milestone', 4, 7);

-- A milestone cannot have cards under it. None should exist; if one does, it stops being a milestone.
UPDATE tracker.task t SET type = 'task'
 WHERE t.type = 'milestone' AND EXISTS (SELECT 1 FROM tracker.task c WHERE c.parent_task_id = t.id);

UPDATE tracker.task SET kind = 'milestone' WHERE type = 'milestone';
UPDATE tracker.task SET kind = 'task' WHERE kind IS NULL;

ALTER TABLE tracker.task ALTER COLUMN kind SET DEFAULT 'task';
ALTER TABLE tracker.task ALTER COLUMN kind SET NOT NULL;
ALTER TABLE tracker.task
    ADD CONSTRAINT task_kind_matches_type CHECK ((type = 'milestone') = (kind = 'milestone'));

-- Keeps type and kind in step, whichever one was set. Its name sorts before
-- task_parent_is_higher_kind so that trigger sees the kind this one settles on.
CREATE FUNCTION tracker.sync_kind_and_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.type = 'milestone' OR NEW.kind = 'milestone' THEN
            NEW.type := 'milestone';
            NEW.kind := 'milestone';
        END IF;
    ELSIF NEW.kind IS DISTINCT FROM OLD.kind THEN
        NEW.type := CASE WHEN NEW.kind = 'milestone' THEN 'milestone' ELSE 'task' END;
    ELSIF NEW.type IS DISTINCT FROM OLD.type THEN
        NEW.kind := CASE WHEN NEW.type = 'milestone' THEN 'milestone' ELSE 'task' END;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_kind_type_sync BEFORE INSERT OR UPDATE OF kind, type ON tracker.task
    FOR EACH ROW EXECUTE FUNCTION tracker.sync_kind_and_type();
