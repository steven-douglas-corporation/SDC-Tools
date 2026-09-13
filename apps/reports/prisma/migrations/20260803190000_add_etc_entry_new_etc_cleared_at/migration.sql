-- Clear ETC (2026-08-03): lets a New ETC cell be "deliberately blank" as opposed
-- to merely "no draft saved".
--
-- On a reopened month a cell seeds from `newEtc` whenever `newEtcDraft` is NULL,
-- so the Clear button could not express itself through newEtcDraft alone — the
-- cleared cell would simply fall back to the value it was submitted with.
--
-- Additive and nullable, so it is safe to apply to a running instance; existing
-- rows read as "never cleared".
ALTER TABLE `EtcEntry` ADD COLUMN `newEtcClearedAt` DATETIME(3) NULL;
