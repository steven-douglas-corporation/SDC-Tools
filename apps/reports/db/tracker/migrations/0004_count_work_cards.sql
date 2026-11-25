-- SDC Project Tracker: a project's "done" count is over the cards that carry work.
--
-- Until now task_count and done_count counted every card, so an Epic counted as one more card
-- beside the work under it. They now count only cards with nothing under them, which is the
-- same set the forecast schedules and the hours columns already used.
--
-- Only those two columns change. The column list is the same, so the view is replaced in place.

CREATE OR REPLACE VIEW tracker.project_rollup AS
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
       FROM tracker.task m
       JOIN tracker.workflow_status ms ON ms.id = m.status_id
  LEFT JOIN tracker.task_forecast mf
         ON mf.task_id = m.id AND mf.run_id = (SELECT run_id FROM tracker.current_schedule_run)
      WHERE m.project_id = p.id AND m.type = 'milestone' AND m.archived_at IS NULL
        AND ms.category NOT IN ('done', 'cancelled')
      ORDER BY coalesce(mf.scheduled_finish, m.due_date, m.estimated_completion_date) NULLS LAST, m.number
      LIMIT 1)                                      AS next_milestone
FROM tracker.project p
LEFT JOIN tracker.project_forecast pf
       ON pf.project_id = p.id AND pf.run_id = (SELECT run_id FROM tracker.current_schedule_run)
LEFT JOIN LATERAL (
    SELECT
        count(*) FILTER (WHERE s.category <> 'cancelled' AND leaf.is_leaf)        AS task_count,
        count(*) FILTER (WHERE s.category = 'done' AND leaf.is_leaf)              AS done_count,
        sum(t.effort_estimate_hours) FILTER (WHERE s.category <> 'cancelled' AND leaf.is_leaf) AS total_hours,
        sum(t.effort_estimate_hours) FILTER (WHERE s.category = 'done' AND leaf.is_leaf)       AS done_hours,
        max(coalesce(t.actual_completion_date, t.estimated_completion_date))
            FILTER (WHERE s.category <> 'cancelled')                              AS estimated_completion_date
    FROM tracker.task t
    JOIN tracker.workflow_status s ON s.id = t.status_id
    CROSS JOIN LATERAL (SELECT NOT EXISTS (SELECT 1 FROM tracker.task c
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
                                   now() - make_interval(days => (SELECT stale_after_days FROM tracker.settings)))) AS stale_tasks
    FROM tracker.open_leaf_task t
    LEFT JOIN tracker.task_forecast f
           ON f.task_id = t.id AND f.run_id = (SELECT run_id FROM tracker.current_schedule_run)
    WHERE t.project_id = p.id
) o ON true;
