-- SDC Project Tracker: schema (PostgreSQL 15+)
--
-- Revised from the 2026-11-11 draft to match docs/project-tracker/DESIGN.md.
--
-- Rules this file relies on
--  * Names are lowercase with underscores. Nothing is quoted.
--  * All effort is in hours of project work. A "day" is the global project day (6 hours of 8 by
--    default, see capacity_setting), so an estimate of "1 Day" is stored as 6.
--  * One write path. The service layer writes tasks, logs and dates in one transaction. The
--    forecast engine is the only writer of the forecast tables. See 0002_roles.sql.
--  * Tasks are archived (archived_at), never deleted, so history stays intact.
--  * People type planned_start_date, estimated_completion_date and due_date. The engine writes
--    its own dates to task_forecast and never touches the typed ones.

CREATE SCHEMA IF NOT EXISTS tracker;
SET search_path = tracker, public;

-- ---------- types ----------
CREATE TYPE status_category AS ENUM ('todo', 'in_progress', 'blocked', 'done', 'cancelled');
CREATE TYPE project_state   AS ENUM ('planned', 'active', 'on_hold', 'completed', 'cancelled');
CREATE TYPE task_type       AS ENUM ('task', 'milestone');
CREATE TYPE sprint_state    AS ENUM ('planned', 'active', 'closed');
CREATE TYPE member_role     AS ENUM ('viewer', 'contributor', 'manager');
CREATE TYPE global_role     AS ENUM ('admin', 'portfolio_owner');   -- portfolio_owner sets the stack rank
CREATE TYPE pr_state        AS ENUM ('open', 'closed', 'merged');
-- Only finish-to-start is scheduled today. Add values here when the engine supports them.
CREATE TYPE dependency_type AS ENUM ('finish_to_start');
CREATE TYPE capacity_scope  AS ENUM ('global', 'team', 'person');
CREATE TYPE task_tracked_field AS ENUM (
    'estimated_completion_date', 'planned_start_date', 'due_date', 'not_before_date',
    'effort_estimate_hours', 'remaining_effort_hours', 'assignee', 'role_pool', 'sprint',
    'priority', 'expected_unblock_date', 'dependency');
CREATE TYPE project_tracked_field AS ENUM (
    'target_date', 'portfolio_rank', 'state', 'priority', 'owner');

-- ---------- settings (one row) ----------
CREATE TABLE settings (
    id               boolean PRIMARY KEY DEFAULT true CHECK (id),
    stale_after_days integer NOT NULL DEFAULT 7 CHECK (stale_after_days > 0)  -- remaining effort older than this is stale
);
INSERT INTO settings DEFAULT VALUES;

-- ---------- people, teams, role pools ----------
CREATE TABLE team (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE
);

-- The shared user key. entra_object_id is filled once sign-in is decided (RAID D-11); the
-- surrogate id keeps every other table independent of that decision.
CREATE TABLE person (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entra_object_id       uuid UNIQUE,
    email                 text NOT NULL UNIQUE CHECK (email = lower(email)),
    display_name          text NOT NULL,
    paylocity_employee_id text UNIQUE,
    team_id               bigint REFERENCES team(id) ON DELETE SET NULL,   -- where the person sits
    active                boolean NOT NULL DEFAULT true,
    created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person_global_role (
    person_id bigint      NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    role      global_role NOT NULL,
    PRIMARY KEY (person_id, role)
);

-- A role pool is a skill, not a department: one person can be in several.
CREATE TABLE role_pool (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE,
    description text
);

CREATE TABLE role_pool_member (
    role_pool_id bigint NOT NULL REFERENCES role_pool(id) ON DELETE CASCADE,
    person_id    bigint NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    PRIMARY KEY (role_pool_id, person_id)
);

-- ---------- capacity: global default, team override, person override ----------
-- The most specific row in effect on a day wins, field by field (a NULL field falls through to
-- the next level). The global row with no dates must always exist.
CREATE TABLE capacity_setting (
    id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope                 capacity_scope NOT NULL,
    team_id               bigint REFERENCES team(id) ON DELETE CASCADE,
    person_id             bigint REFERENCES person(id) ON DELETE CASCADE,
    project_hours_per_day numeric(4,2) CHECK (project_hours_per_day >= 0 AND project_hours_per_day <= 24),
    working_weekdays      smallint[] CHECK (working_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[]),  -- ISO, 1 = Monday
    effective_from        date,
    effective_to          date,
    note                  text,
    CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
    CHECK ((scope = 'global' AND team_id IS NULL     AND person_id IS NULL)
        OR (scope = 'team'   AND team_id IS NOT NULL AND person_id IS NULL)
        OR (scope = 'person' AND team_id IS NULL     AND person_id IS NOT NULL))
);
CREATE INDEX capacity_setting_person ON capacity_setting (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX capacity_setting_team   ON capacity_setting (team_id)   WHERE team_id IS NOT NULL;

INSERT INTO capacity_setting (scope, project_hours_per_day, working_weekdays, note)
VALUES ('global', 6, '{1,2,3,4,5}', 'Global default: 6 hours of project work in an 8-hour day (RAID A-04)');

-- May become a view over the warehouse holiday table (RAID DEP-05).
CREATE TABLE company_holiday (
    holiday_date date PRIMARY KEY,
    name         text NOT NULL
);

CREATE TABLE time_off (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id   bigint       NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    start_date  date         NOT NULL,
    end_date    date         NOT NULL,
    day_portion numeric(3,2) NOT NULL DEFAULT 1 CHECK (day_portion > 0 AND day_portion <= 1),  -- 1 = full day off
    note        text,
    CHECK (end_date >= start_date)
);
CREATE INDEX time_off_person ON time_off (person_id, start_date, end_date);

-- ---------- estimate buckets (company standard) ----------
-- Shown as "label (hours)", e.g. "1 Day (6 hours)". The task stores the hours, so changing a
-- bucket later does not alter estimates already made. low_hours and high_hours are the range the
-- simulation samples from (placeholders, to be calibrated).
CREATE TABLE effort_bucket (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    label        text         NOT NULL UNIQUE,
    hours        numeric(6,2) NOT NULL CHECK (hours > 0),
    low_hours    numeric(6,2) NOT NULL,
    high_hours   numeric(6,2) NOT NULL,
    sort_order   integer      NOT NULL,
    should_split boolean      NOT NULL DEFAULT false,
    active       boolean      NOT NULL DEFAULT true,
    CHECK (low_hours > 0 AND low_hours <= hours AND high_hours >= hours)
);
INSERT INTO effort_bucket (label, hours, low_hours, high_hours, sort_order, should_split) VALUES
    ('Half a day or less',  3,  1.5,  4.5, 10, false),
    ('1 Day',               6,  4.5, 12,   20, false),
    ('3 Days',             18, 12,   24,   30, false),
    ('1 Week',             30, 24,   45,   40, false),
    ('2 Weeks',            60, 45,   90,   50, true);

-- ---------- projects ----------
CREATE TABLE project (
    id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    key                    text          NOT NULL UNIQUE CHECK (key ~ '^[A-Z][A-Z0-9]{1,7}$'),  -- e.g. BIN -> BIN-42
    name                   text          NOT NULL,
    description            text,
    objective              text,
    definition_of_done     text,
    owner_person_id        bigint        NOT NULL REFERENCES person(id),
    team_id                bigint        REFERENCES team(id) ON DELETE SET NULL,
    job_number             text,                                       -- optional link to a customer job
    priority               smallint      NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),  -- 1 = highest
    state                  project_state NOT NULL DEFAULT 'planned',
    portfolio_rank         integer       CHECK (portfolio_rank > 0),   -- company-wide stack rank, 1 = first
    estimate_low_factor    numeric(3,2)  NOT NULL DEFAULT 0.80 CHECK (estimate_low_factor > 0 AND estimate_low_factor <= 1),
    estimate_high_factor   numeric(3,2)  NOT NULL DEFAULT 1.50 CHECK (estimate_high_factor >= 1),  -- used when a task has no bucket
    target_date            date,
    actual_completion_date date,
    next_task_number       integer       NOT NULL DEFAULT 1,           -- per-project task counter
    created_by             bigint        NOT NULL REFERENCES person(id),
    created_at             timestamptz   NOT NULL DEFAULT now(),
    updated_at             timestamptz   NOT NULL DEFAULT now(),
    -- An active project must have a place in the order, or the forecast cannot schedule it.
    CONSTRAINT project_active_needs_rank CHECK (state <> 'active' OR portfolio_rank IS NOT NULL),
    -- No two open projects share a rank. An exclusion constraint, not a unique index, because it
    -- can be deferred: ranks can be swapped in one statement or one transaction.
    CONSTRAINT project_rank_unique EXCLUDE USING btree (portfolio_rank WITH =)
        WHERE (state IN ('planned', 'active')) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX project_job ON project (job_number) WHERE job_number IS NOT NULL;

CREATE TABLE project_member (
    project_id bigint      NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    person_id  bigint      NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    role       member_role NOT NULL DEFAULT 'contributor',
    PRIMARY KEY (project_id, person_id)
);

CREATE TABLE project_change_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id bigint                NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    field      project_tracked_field NOT NULL,
    old_value  text,
    new_value  text,
    changed_by bigint                NOT NULL REFERENCES person(id),
    changed_at timestamptz           NOT NULL DEFAULT now(),
    reason     text
);
CREATE INDEX project_change_log_project ON project_change_log (project_id, field, changed_at);

-- Optional. If a person has allocations in effect, each project gets its share of their
-- capacity; a share whose project has no work for them is released to the others.
CREATE TABLE resource_allocation (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_id  bigint       NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    project_id bigint       NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    percent    numeric(5,2) NOT NULL CHECK (percent > 0 AND percent <= 100),
    start_date date,
    end_date   date,
    CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE INDEX resource_allocation_person ON resource_allocation (person_id, start_date);

-- ---------- statuses (Kanban columns) ----------
CREATE TABLE workflow_status (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id bigint          NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name       text            NOT NULL,
    category   status_category NOT NULL,          -- drives done, blocked and reporting logic
    sort_order integer         NOT NULL,
    wip_limit  integer         CHECK (wip_limit > 0),
    UNIQUE (project_id, name),
    UNIQUE (id, project_id)                       -- lets task enforce status-belongs-to-project
);

-- ---------- sprints ----------
CREATE TABLE sprint (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id      bigint       NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    name            text         NOT NULL,
    goal            text,
    start_date      date         NOT NULL,
    end_date        date         NOT NULL,
    state           sprint_state NOT NULL DEFAULT 'planned',
    committed_hours numeric(10,2),                -- snapshot when the sprint starts
    completed_hours numeric(10,2),                -- snapshot when the sprint closes
    closed_at       timestamptz,
    CHECK (end_date >= start_date),
    UNIQUE (project_id, name),
    UNIQUE (id, project_id)
);
CREATE UNIQUE INDEX one_active_sprint_per_project ON sprint (project_id) WHERE state = 'active';

-- ---------- tasks ----------
CREATE TABLE task (
    id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id                  bigint        NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    number                      integer       NOT NULL,                 -- task key = project.key || '-' || number
    parent_task_id              bigint,
    type                        task_type     NOT NULL DEFAULT 'task',
    title                       text          NOT NULL,
    description                 text,                                   -- markdown
    assignee_person_id          bigint        REFERENCES person(id),
    role_pool_id                bigint        REFERENCES role_pool(id), -- used by the forecast until a person is assigned
    reporter_person_id          bigint        NOT NULL REFERENCES person(id),
    status_id                   bigint        NOT NULL,
    priority                    smallint      NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    effort_bucket_id            bigint        REFERENCES effort_bucket(id),  -- the standard size chosen, if any
    effort_estimate_hours       numeric(10,2) CHECK (effort_estimate_hours >= 0),   -- copied from the bucket when chosen
    remaining_effort_hours      numeric(10,2) CHECK (remaining_effort_hours >= 0),  -- drives the forecast
    remaining_effort_updated_at timestamptz,                            -- set on change, or by a "still right" confirm
    not_before_date             date,                                   -- constraint the engine obeys
    not_before_reason           text,
    blocked_reason              text,                                   -- required by the service when status is blocked
    expected_unblock_date       date,                                   -- with it, a blocked task is scheduled from this date
    planned_start_date          date,                                   -- a person's intent; the engine ignores it
    estimated_completion_date   date,                                   -- a person's prediction; changes are logged
    baseline_completion_date    date,                                   -- first estimated_completion_date; set once by the service
    due_date                    date,                                   -- a commitment, mainly for milestones
    actual_completion_date      date,                                   -- set when status enters a done category
    sprint_id                   bigint,
    job_number                  text,                                   -- optional links to Paylocity codes
    section_code                text,
    function_code               text,
    board_rank                  numeric       NOT NULL DEFAULT 0,       -- order inside a Kanban column
    archived_at                 timestamptz,
    created_at                  timestamptz   NOT NULL DEFAULT now(),
    updated_at                  timestamptz   NOT NULL DEFAULT now(),
    UNIQUE (project_id, number),
    UNIQUE (id, project_id),
    FOREIGN KEY (status_id, project_id) REFERENCES workflow_status (id, project_id),
    FOREIGN KEY (sprint_id, project_id) REFERENCES sprint (id, project_id),
    FOREIGN KEY (parent_task_id, project_id) REFERENCES task (id, project_id),   -- parent is in the same project
    CHECK (parent_task_id IS NULL OR parent_task_id <> id),
    CHECK (planned_start_date IS NULL OR estimated_completion_date IS NULL
           OR estimated_completion_date >= planned_start_date),
    CHECK (not_before_date IS NULL OR not_before_reason IS NOT NULL),
    CHECK (type <> 'milestone'
           OR (coalesce(effort_estimate_hours, 0) = 0 AND coalesce(remaining_effort_hours, 0) = 0))
);
CREATE INDEX task_board    ON task (project_id, status_id, board_rank) WHERE archived_at IS NULL;
CREATE INDEX task_assignee ON task (assignee_person_id) WHERE assignee_person_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX task_sprint   ON task (sprint_id) WHERE sprint_id IS NOT NULL;
CREATE INDEX task_parent   ON task (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX task_job      ON task (job_number, section_code, function_code) WHERE job_number IS NOT NULL;

CREATE TABLE task_comment (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id          bigint      NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    author_person_id bigint      NOT NULL REFERENCES person(id),
    body             text        NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    edited_at        timestamptz
);
CREATE INDEX task_comment_task ON task_comment (task_id, created_at);

-- ---------- history ----------
CREATE TABLE status_log (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id        bigint      NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    from_status_id bigint      REFERENCES workflow_status(id),         -- NULL on creation
    to_status_id   bigint      NOT NULL REFERENCES workflow_status(id),
    changed_by     bigint      NOT NULL REFERENCES person(id),
    changed_at     timestamptz NOT NULL DEFAULT now(),
    note           text
);
CREATE INDEX status_log_task ON status_log (task_id, changed_at);

CREATE TABLE task_change_log (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id    bigint             NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    field      task_tracked_field NOT NULL,
    old_value  text,
    new_value  text,
    changed_by bigint             NOT NULL REFERENCES person(id),
    changed_at timestamptz        NOT NULL DEFAULT now(),
    reason     text
);
CREATE INDEX task_change_log_task ON task_change_log (task_id, field, changed_at);

-- ---------- dependencies ----------
-- Adding or removing a row is logged in task_change_log (field 'dependency') on the successor.
-- Cycles are rejected by the service layer.
CREATE TABLE task_dependency (
    predecessor_task_id bigint          NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    successor_task_id   bigint          NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    type                dependency_type NOT NULL DEFAULT 'finish_to_start',
    lag_days            integer         NOT NULL DEFAULT 0 CHECK (lag_days >= 0),  -- calendar days
    PRIMARY KEY (predecessor_task_id, successor_task_id),
    CHECK (predecessor_task_id <> successor_task_id)
);
CREATE INDEX task_dependency_successor ON task_dependency (successor_task_id);

-- ---------- forecast output (written only by the forecast engine) ----------
CREATE TABLE schedule_run (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    started_at        timestamptz NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    status            text        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
    error             text,
    triggered_by      text        NOT NULL CHECK (triggered_by IN ('change', 'nightly', 'manual')),
    as_of_date        date        NOT NULL,
    simulations       integer     NOT NULL DEFAULT 0,                  -- 0 = single schedule only
    tasks_scheduled   integer,
    tasks_unscheduled integer,
    settings          jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- One row per open task, rewritten by every run. A run with no simulation leaves p50/p80 and
-- simulation_run_id as they were, so their age is visible.
CREATE TABLE task_forecast (
    task_id               bigint PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
    run_id                bigint NOT NULL REFERENCES schedule_run(id),
    scheduled_start       date,
    scheduled_finish      date,
    assigned_person_id    bigint REFERENCES person(id),                -- the pool member chosen, for pool tasks
    driver                text CHECK (driver IN ('start', 'not_before', 'blocked_until', 'predecessor', 'resource')),
    driver_task_id        bigint REFERENCES task(id) ON DELETE SET NULL,
    priority_from_task_id bigint REFERENCES task(id) ON DELETE SET NULL,  -- the task this one was pulled forward for
    unscheduled_reason    text,                                        -- e.g. 'no estimate', 'no assignee', 'blocked'
    p50_finish            date,
    p80_finish            date,
    simulation_run_id     bigint REFERENCES schedule_run(id),
    computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_forecast_run ON task_forecast (run_id);

CREATE TABLE project_forecast (
    project_id         bigint PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
    run_id             bigint NOT NULL REFERENCES schedule_run(id),
    finish_date        date,                                           -- single schedule
    p50_finish         date,
    p80_finish         date,
    simulation_run_id  bigint REFERENCES schedule_run(id),
    unscheduled_tasks  integer       NOT NULL DEFAULT 0,
    unscheduled_hours  numeric(10,2) NOT NULL DEFAULT 0,
    computed_at        timestamptz   NOT NULL DEFAULT now()
);

-- One row per project per kept run (keep nightly runs) so forecast drift can be charted.
CREATE TABLE project_forecast_history (
    project_id  bigint NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    run_id      bigint NOT NULL REFERENCES schedule_run(id),
    finish_date date,
    p50_finish  date,
    p80_finish  date,
    PRIMARY KEY (project_id, run_id)
);

-- ---------- GitHub links (loose: a PR can link to several tasks and vice versa) ----------
CREATE TABLE github_pr_link (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id        bigint      NOT NULL REFERENCES task(id) ON DELETE CASCADE,
    repo_full_name text        NOT NULL,                               -- 'owner/repo'
    pr_number      integer     NOT NULL,
    url            text        NOT NULL,
    title          text,
    state          pr_state,
    author_login   text,
    merged_at      timestamptz,
    link_source    text        NOT NULL DEFAULT 'manual' CHECK (link_source IN ('manual', 'auto')),
    linked_by      bigint      REFERENCES person(id),
    linked_at      timestamptz NOT NULL DEFAULT now(),
    last_synced_at timestamptz,
    UNIQUE (task_id, repo_full_name, pr_number)
);
CREATE INDEX github_pr_link_pr ON github_pr_link (repo_full_name, pr_number);

-- ---------- helpers ----------
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END $$;

CREATE TRIGGER project_set_updated_at BEFORE UPDATE ON project
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON task
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Stamps remaining effort whenever its value changes. A "still right" confirm sets the column
-- directly without changing the value.
CREATE FUNCTION stamp_remaining_effort() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.remaining_effort_hours IS NOT NULL AND NEW.remaining_effort_updated_at IS NULL THEN
            NEW.remaining_effort_updated_at = now();
        END IF;
    ELSIF NEW.remaining_effort_hours IS DISTINCT FROM OLD.remaining_effort_hours
          AND NEW.remaining_effort_updated_at IS NOT DISTINCT FROM OLD.remaining_effort_updated_at THEN
        NEW.remaining_effort_updated_at = now();
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_stamp_remaining_effort BEFORE INSERT OR UPDATE ON task
    FOR EACH ROW EXECUTE FUNCTION stamp_remaining_effort();

-- Subtasks go one level deep: a parent cannot itself have a parent.
CREATE FUNCTION enforce_one_level_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_task_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM task p WHERE p.id = NEW.parent_task_id AND p.parent_task_id IS NOT NULL) THEN
            RAISE EXCEPTION 'task % cannot be a parent because it is itself a subtask', NEW.parent_task_id
                USING ERRCODE = 'check_violation';
        END IF;
        IF EXISTS (SELECT 1 FROM task c WHERE c.parent_task_id = NEW.id) THEN
            RAISE EXCEPTION 'task % has subtasks and cannot become a subtask', NEW.id
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER task_one_level_parent BEFORE INSERT OR UPDATE OF parent_task_id ON task
    FOR EACH ROW EXECUTE FUNCTION enforce_one_level_parent();

-- Copies the default Kanban columns into a new project. Call right after inserting the project.
CREATE FUNCTION seed_default_statuses(p_project_id bigint) RETURNS void LANGUAGE sql AS $$
    INSERT INTO tracker.workflow_status (project_id, name, category, sort_order) VALUES
        (p_project_id, 'Backlog',     'todo',        10),
        (p_project_id, 'To Do',       'todo',        20),
        (p_project_id, 'In Progress', 'in_progress', 30),
        (p_project_id, 'In Review',   'in_progress', 40),
        (p_project_id, 'Blocked',     'blocked',     50),
        (p_project_id, 'Done',        'done',        60),
        (p_project_id, 'Cancelled',   'cancelled',   70);
$$;

-- Hours of project work a person has on a day, before time off and allocations.
-- Person override, then their team's, then the global default; field by field.
CREATE FUNCTION person_capacity_on(p_person_id bigint, p_day date)
RETURNS TABLE (project_hours_per_day numeric, working_weekdays smallint[]) LANGUAGE sql STABLE AS $$
    WITH candidates AS (
        SELECT c.project_hours_per_day, c.working_weekdays,
               CASE c.scope WHEN 'person' THEN 1 WHEN 'team' THEN 2 ELSE 3 END AS level,
               c.effective_from, c.id
        FROM tracker.capacity_setting c
        LEFT JOIN tracker.person pe ON pe.id = p_person_id
        WHERE (c.effective_from IS NULL OR c.effective_from <= p_day)
          AND (c.effective_to   IS NULL OR c.effective_to   >= p_day)
          AND (c.scope = 'global'
               OR (c.scope = 'person' AND c.person_id = p_person_id)
               OR (c.scope = 'team'   AND c.team_id = pe.team_id))
    )
    SELECT
        (SELECT k.project_hours_per_day FROM candidates k WHERE k.project_hours_per_day IS NOT NULL
          ORDER BY k.level, k.effective_from DESC NULLS LAST, k.id DESC LIMIT 1),
        (SELECT k.working_weekdays FROM candidates k WHERE k.working_weekdays IS NOT NULL
          ORDER BY k.level, k.effective_from DESC NULLS LAST, k.id DESC LIMIT 1);
$$;

-- ---------- reporting ----------
-- The latest finished run. Forecast rows from older runs are ignored by the views below.
CREATE VIEW current_schedule_run AS
SELECT r.id AS run_id, r.as_of_date, r.finished_at
FROM schedule_run r
WHERE r.status = 'succeeded'
ORDER BY r.id DESC
LIMIT 1;

-- Open, unarchived tasks that carry effort themselves. A parent with open subtasks is left out
-- so its hours are not counted twice.
CREATE VIEW open_leaf_task AS
SELECT t.*, s.category
FROM task t
JOIN workflow_status s ON s.id = t.status_id
WHERE t.archived_at IS NULL
  AND s.category NOT IN ('done', 'cancelled')
  AND NOT EXISTS (SELECT 1 FROM task c WHERE c.parent_task_id = t.id AND c.archived_at IS NULL);

-- One row per project for the leadership view.
--  * forecast_completion_date, p50 and p80 come from project_forecast, the engine's one answer.
--  * at_risk compares P80 with the target (P50, then the single schedule, if no simulation has run).
--  * unscheduled and stale work is counted beside the dates so it cannot flatter them.
CREATE VIEW project_rollup AS
SELECT
    p.id   AS project_id,
    p.key,
    p.name,
    p.state,
    p.priority,
    p.portfolio_rank,
    p.owner_person_id,
    p.team_id,
    p.job_number,
    p.target_date,
    a.task_count,
    a.done_count,
    a.total_hours,
    a.done_hours,
    o.remaining_hours,
    a.estimated_completion_date,
    pf.finish_date                                  AS forecast_completion_date,
    pf.p50_finish,
    pf.p80_finish,
    coalesce(pf.p80_finish, pf.p50_finish, pf.finish_date) > p.target_date AS at_risk,
    CASE WHEN pf.p80_finish IS NOT NULL THEN 'p80'
         WHEN pf.p50_finish IS NOT NULL THEN 'p50'
         WHEN pf.finish_date IS NOT NULL THEN 'single schedule' END        AS at_risk_basis,
    coalesce(o.unscheduled_tasks, 0)                AS unscheduled_tasks,
    coalesce(o.unscheduled_hours, 0)                AS unscheduled_hours,
    coalesce(o.unestimated_tasks, 0)                AS unestimated_tasks,
    coalesce(o.stale_tasks, 0)                      AS stale_tasks,
    (SELECT m.title
       FROM task m
       JOIN workflow_status ms ON ms.id = m.status_id
  LEFT JOIN task_forecast mf ON mf.task_id = m.id AND mf.run_id = (SELECT run_id FROM current_schedule_run)
      WHERE m.project_id = p.id AND m.type = 'milestone' AND m.archived_at IS NULL
        AND ms.category NOT IN ('done', 'cancelled')
      ORDER BY coalesce(mf.scheduled_finish, m.due_date, m.estimated_completion_date) NULLS LAST, m.number
      LIMIT 1)                                      AS next_milestone
FROM project p
LEFT JOIN project_forecast pf
       ON pf.project_id = p.id AND pf.run_id = (SELECT run_id FROM current_schedule_run)
LEFT JOIN LATERAL (
    SELECT
        count(*) FILTER (WHERE s.category <> 'cancelled')                         AS task_count,
        count(*) FILTER (WHERE s.category = 'done')                               AS done_count,
        sum(t.effort_estimate_hours) FILTER (WHERE s.category <> 'cancelled' AND leaf.is_leaf) AS total_hours,
        sum(t.effort_estimate_hours) FILTER (WHERE s.category = 'done' AND leaf.is_leaf)       AS done_hours,
        max(coalesce(t.actual_completion_date, t.estimated_completion_date))
            FILTER (WHERE s.category <> 'cancelled')                              AS estimated_completion_date
    FROM task t
    JOIN workflow_status s ON s.id = t.status_id
    CROSS JOIN LATERAL (SELECT NOT EXISTS (SELECT 1 FROM task c
                                           WHERE c.parent_task_id = t.id AND c.archived_at IS NULL) AS is_leaf) leaf
    WHERE t.project_id = p.id AND t.archived_at IS NULL
) a ON true
LEFT JOIN LATERAL (
    SELECT
        sum(coalesce(t.remaining_effort_hours, t.effort_estimate_hours))          AS remaining_hours,
        count(*) FILTER (WHERE f.scheduled_finish IS NULL)                        AS unscheduled_tasks,
        sum(coalesce(t.remaining_effort_hours, t.effort_estimate_hours))
            FILTER (WHERE f.scheduled_finish IS NULL)                             AS unscheduled_hours,
        count(*) FILTER (WHERE t.type = 'task'
                           AND coalesce(t.remaining_effort_hours, t.effort_estimate_hours) IS NULL) AS unestimated_tasks,
        count(*) FILTER (WHERE t.type = 'task'
                           AND (t.remaining_effort_updated_at IS NULL
                                OR t.remaining_effort_updated_at <
                                   now() - make_interval(days => (SELECT stale_after_days FROM settings)))) AS stale_tasks
    FROM open_leaf_task t
    LEFT JOIN task_forecast f ON f.task_id = t.id AND f.run_id = (SELECT run_id FROM current_schedule_run)
    WHERE t.project_id = p.id
) o ON true;

-- What a person typed versus what the engine forecasts, per open task.
--  * slip_days: forecast later than the current typed date.
--  * baseline_slip_days: forecast later than the first date ever typed, which editing cannot erase.
--  * due_at_risk: forecast (P80 when available) later than the due date.
CREATE VIEW task_date_comparison AS
SELECT t.id AS task_id, t.project_id, t.number, t.title, t.type,
       t.assignee_person_id, t.role_pool_id,
       t.estimated_completion_date,
       t.baseline_completion_date,
       t.due_date,
       f.scheduled_start    AS forecast_start,
       f.scheduled_finish   AS forecast_finish,
       f.p50_finish,
       f.p80_finish,
       (f.scheduled_finish - t.estimated_completion_date) AS slip_days,
       (f.scheduled_finish - t.baseline_completion_date)  AS baseline_slip_days,
       coalesce(f.p80_finish, f.scheduled_finish) > t.due_date AS due_at_risk,
       f.driver,
       f.driver_task_id,
       f.priority_from_task_id,
       f.unscheduled_reason
FROM open_leaf_task t
LEFT JOIN task_forecast f ON f.task_id = t.id AND f.run_id = (SELECT run_id FROM current_schedule_run);
