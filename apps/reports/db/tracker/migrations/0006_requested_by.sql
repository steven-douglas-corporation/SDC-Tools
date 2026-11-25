-- SDC Project Tracker: who wants a card, and who made it, are two facts.
--
-- A card had one person on it besides the assignee, called the reporter: whoever created it.
-- That could not say "created on someone else's behalf", by a colleague or by automation.
--
--   requested_by_person_id   who wants the work. Starts as the creator, can be changed, and a
--                            change is logged like any other tracked field.
--   created_by_person_id     who (or what) made the record. Set once and never changed, so the
--                            history of a card can be trusted.
--
-- The old column is renamed, not copied: it has always meant "the person behind this card".

ALTER TABLE tracker.task RENAME COLUMN reporter_person_id TO requested_by_person_id;

ALTER TABLE tracker.task ADD COLUMN created_by_person_id bigint REFERENCES tracker.person (id);
UPDATE tracker.task SET created_by_person_id = requested_by_person_id;
ALTER TABLE tracker.task ALTER COLUMN created_by_person_id SET NOT NULL;

ALTER TYPE tracker.task_tracked_field ADD VALUE 'requested_by';

-- On insert the creator defaults to the requester, so the simple case needs one name, not two.
-- After that the creator is fixed.
CREATE FUNCTION tracker.keep_created_by() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.created_by_person_id := coalesce(NEW.created_by_person_id, NEW.requested_by_person_id);
    ELSIF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN
        RAISE EXCEPTION 'task %: who created a card cannot be changed', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_keep_created_by BEFORE INSERT OR UPDATE OF created_by_person_id ON tracker.task
    FOR EACH ROW EXECUTE FUNCTION tracker.keep_created_by();
