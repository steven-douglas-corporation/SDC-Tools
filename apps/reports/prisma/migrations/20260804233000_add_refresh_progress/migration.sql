-- §30 — the stage a running refresh is currently on.
--
-- `steps` was written only by closeRun, when the pass was already over, so for the
-- whole duration of a refresh the only observable state was "running". That is why the
-- button sat on "Refreshing application data…" with nothing to distinguish a slow pass
-- from a stuck one. refresh-service now writes `steps` incrementally and stamps the
-- stage now starting here, so any tab can ask what is happening.
--
-- NULL once the run finishes: a completed run has no current stage.
ALTER TABLE `RefreshRun` ADD COLUMN `currentStage` VARCHAR(64) NULL;
