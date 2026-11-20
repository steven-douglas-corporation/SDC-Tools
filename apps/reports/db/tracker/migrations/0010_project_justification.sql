-- SDC Project Tracker: a project says why it is worth doing, and what it is worth.
--
-- Two things on a project, both asked for when it is created and before it is made active:
--
--   justification    the reason in words: what the project saves, earns or prevents
--   value_bucket_id  its effect on the bottom line in a year, as one of a short list of
--                    dollar ranges
--
-- A range, not a figure, for the same reason effort is a bucket: nobody knows the number to
-- the dollar, and a range can be chosen honestly in a few seconds. The ranges are a table,
-- like effort_bucket, so they can be changed without touching code.
--
-- Projects that exist already have neither. Nothing here forces them to: the rule is enforced
-- where a project is created or made active (service/projects.ts), not by a constraint that
-- an existing active project would fail.

CREATE TABLE tracker.value_bucket (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label        text    NOT NULL UNIQUE,
    low_dollars  numeric NOT NULL CHECK (low_dollars >= 0),
    high_dollars numeric CHECK (high_dollars IS NULL OR high_dollars > low_dollars),  -- NULL = no upper end
    sort_order   integer NOT NULL UNIQUE
);
COMMENT ON TABLE tracker.value_bucket IS
    'What a project is worth to the bottom line in a year, as a dollar range. Company standard.';

INSERT INTO tracker.value_bucket (label, low_dollars, high_dollars, sort_order) VALUES
    ('Under $10k a year',       0,       10000,   1),
    ('$10k to $50k a year',     10000,   50000,   2),
    ('$50k to $250k a year',    50000,   250000,  3),
    ('$250k to $1M a year',     250000,  1000000, 4),
    ('Over $1M a year',         1000000, NULL,    5);

ALTER TABLE tracker.project
    ADD COLUMN justification   text,
    ADD COLUMN value_bucket_id bigint REFERENCES tracker.value_bucket(id);

-- Changes to either are kept in the project's history, like its target date and owner.
ALTER TYPE tracker.project_tracked_field ADD VALUE IF NOT EXISTS 'justification';
ALTER TYPE tracker.project_tracked_field ADD VALUE IF NOT EXISTS 'value';

GRANT SELECT ON tracker.value_bucket TO tracker_service, tracker_engine, tracker_readonly;
