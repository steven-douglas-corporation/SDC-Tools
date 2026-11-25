-- SDC Project Tracker: a checklist on a card.
--
-- A checklist is a short list of things to tick off inside one card: steps too small to be
-- cards of their own. It is a reminder list only. It carries no hours, nobody is assigned to an
-- item, and the forecast never reads it, so ticking items does not move any date. Work that
-- needs an owner, an estimate or a date is a card under this one, not a checklist item.
--
-- Who ticked an item and when is kept on the item. Checklist edits are not written to the
-- card's history, which stays about the things that change the plan.

CREATE TABLE tracker.task_checklist_item (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id              bigint      NOT NULL REFERENCES tracker.task (id) ON DELETE CASCADE,
    body                 text        NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 500),
    -- Order within the card. Not unique: moving an item swaps two values, and ties fall back to id.
    position             integer     NOT NULL,
    done_at              timestamptz,
    done_by_person_id    bigint      REFERENCES tracker.person (id),
    created_by_person_id bigint      NOT NULL REFERENCES tracker.person (id),
    created_at           timestamptz NOT NULL DEFAULT now(),
    -- Ticked means both are set; not ticked means neither is.
    CONSTRAINT task_checklist_item_done_pair CHECK ((done_at IS NULL) = (done_by_person_id IS NULL))
);
CREATE INDEX task_checklist_item_task ON tracker.task_checklist_item (task_id, position, id);

-- 0002 granted on the tables that existed then, so a new table needs its own grants.
GRANT SELECT ON tracker.task_checklist_item TO tracker_service, tracker_engine, tracker_readonly;
GRANT INSERT, UPDATE, DELETE ON tracker.task_checklist_item TO tracker_service;
