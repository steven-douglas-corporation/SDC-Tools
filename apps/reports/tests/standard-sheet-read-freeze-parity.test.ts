import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveNewEtc,
  newEtcForSubmission,
  round2,
  suggestNewEtc,
  confirmedNewEtc,
  isConfirmedEntry,
  isNewEtcDecided,
  newEtcSeedText,
  historyConfirmedAt,
  partsCostCellState,
  partsCostEffectiveNewEtc,
} from "../src/lib/etc";

// ── The read path and the freeze path are ONE rule ───────────────────────────
//
// §69 (2026-09-11) gave newEtcForSubmission a "confirmed" rung so a re-submission
// could not overwrite what managers typed. effectiveNewEtc — what the grid totals,
// the KPI cards and getExecutionEtcByJob read by — kept the old `draft ??
// suggestion`, so the two disagreed on exactly one state: a REOPENED row holding a
// confirmed figure with no draft.
//
// One submission uses both. loadStandardSheetRows runs BEFORE the freeze
// transaction and reaches effectiveNewEtc; submitEtcEntriesInTx freezes
// newEtcForSubmission. So a single click wrote the managers' figures into EtcEntry
// and the carry-forward guesses into StandardSheetSnapshot, which is what a
// submitted month's Standard Sheet renders from.
//
// These tests exist so that can never be true again: for every row the submission
// would actually touch, what is READ equals what would be FROZEN.

type Row = {
  needsReview: boolean;
  newEtc: number;
  newEtcDraft: number | null;
  newEtcClearedAt: Date | null;
  submittedAt: Date | null;
  priorEtc: number;
  hoursWorked: number;
};

const AT = new Date("2026-09-11T19:09:35Z");

// The freeze's expression, verbatim from submitEtcEntriesInTx — `confirmed` is
// confirmedNewEtc, the one predicate (2026-09-14).
function freezeOf(r: Row): number {
  return newEtcForSubmission({
    draft: r.newEtcDraft,
    confirmed: confirmedNewEtc(r),
    cleared: r.newEtcClearedAt != null,
    priorEtc: r.priorEtc,
    hoursWorked: r.hoursWorked,
  });
}

// The page's seed, verbatim from etc/page.tsx / EtcSectionCells.
function seedOf(r: Row): string {
  return newEtcSeedText({
    priorEtc: r.priorEtc,
    hoursWorked: r.hoursWorked,
    draft: r.newEtcDraft,
    confirmed: confirmedNewEtc(r),
    cleared: r.newEtcClearedAt != null,
    locked: !r.needsReview,
    monthComplete: true,
  });
}

test("read == freeze for every state the submission would write", () => {
  // The full cross-product of the three flags that pick a rung, over two shapes of
  // row: one with hours booked this month, one with none (the carry-forward case).
  const shapes = [
    { priorEtc: 191.5, hoursWorked: 178.58, newEtc: 400 }, // 1118 CE — suggestion 12.92
    { priorEtc: 185, hoursWorked: 0, newEtc: 0 }, // 1152 40-211 — suggestion 185
    { priorEtc: 148, hoursWorked: 54.5, newEtc: 160 }, // 1122 ME & CE — suggestion 93.5
    { priorEtc: 0, hoursWorked: 0, newEtc: 0 }, // a row that was always empty
  ];
  let checked = 0;
  for (const shape of shapes) {
    for (const newEtcDraft of [null, 175, 0]) {
      for (const submittedAt of [null, AT]) {
        for (const newEtcClearedAt of [null, AT]) {
          // needsReview false is a frozen row — submitEtcEntriesInTx skips it
          // outright ("An already-confirmed row is history"), so there is no
          // freeze value to agree with. Covered separately below.
          const row: Row = { ...shape, needsReview: true, newEtcDraft, newEtcClearedAt, submittedAt };
          assert.equal(
            effectiveNewEtc(row),
            freezeOf(row),
            `read/freeze split at ${JSON.stringify({ ...row, submittedAt: !!submittedAt, newEtcClearedAt: !!newEtcClearedAt })}`,
          );
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 4 * 3 * 2 * 2);
});

test("a reopened row reads as the manager's confirmed figure, not the carry-forward", () => {
  // 1118 Controls Engineering: prior 191.5, 178.58 worked, manager says 400 more.
  const row: Row = {
    needsReview: true,
    newEtc: 400,
    newEtcDraft: null,
    newEtcClearedAt: null,
    submittedAt: AT,
    priorEtc: 191.5,
    hoursWorked: 178.58,
  };
  assert.equal(effectiveNewEtc(row), 400);
  // suggestNewEtc is the raw subtraction — 191.5 - 178.58 lands on
  // 12.919999999999987 in binary floating point; the rounding to the stored
  // Decimal(10,2) happens in newEtcForSubmission. Compare the rounded figure, which
  // is the 12.92 DEVLOG §69 records this cell being overwritten with.
  assert.equal(round2(suggestNewEtc(191.5, 178.58)), 12.92);
  assert.notEqual(round2(effectiveNewEtc(row)), 12.92);
});

test("a job the managers zeroed stays at zero instead of resurrecting last month's balance", () => {
  // 1152 Container Filling Machine: nothing booked all month, every cell signed off
  // at 0. hoursWorked === 0 is exactly when suggestNewEtc returns priorEtc verbatim,
  // so the old rule gave this row its whole prior balance back — 787 hours and
  // $62,900 of parts across its 11 cells, a $227,053 fee row out of nothing.
  const row: Row = {
    needsReview: true,
    newEtc: 0,
    newEtcDraft: null,
    newEtcClearedAt: null,
    submittedAt: AT,
    priorEtc: 185,
    hoursWorked: 0,
  };
  assert.equal(effectiveNewEtc(row), 0);
  assert.equal(suggestNewEtc(185, 0), 185);
  assert.notEqual(effectiveNewEtc(row), 185);
});

test("a never-submitted row ignores the seed sitting in newEtc", () => {
  // newEtc is populated at seed time on a brand-new row. Without submittedAt it is
  // not a decision anybody made, so it must not be read as one.
  const row: Row = {
    needsReview: true,
    newEtc: 148,
    newEtcDraft: null,
    newEtcClearedAt: null,
    submittedAt: null,
    priorEtc: 148,
    hoursWorked: 54.5,
  };
  assert.equal(effectiveNewEtc(row), 93.5);
});

test("a draft still wins, and a deliberate clear still falls to the suggestion", () => {
  const base = { needsReview: true as const, newEtc: 160, priorEtc: 148, hoursWorked: 54.5, submittedAt: AT };
  assert.equal(effectiveNewEtc({ ...base, newEtcDraft: 175, newEtcClearedAt: null }), 175);
  // 0 is a figure, not a blank.
  assert.equal(effectiveNewEtc({ ...base, newEtcDraft: 0, newEtcClearedAt: null }), 0);
  // Cleared beats confirmed — the cell is blank on screen and its tooltip says a
  // blank submits as the suggestion.
  assert.equal(effectiveNewEtc({ ...base, newEtcDraft: null, newEtcClearedAt: AT }), 93.5);
  // A draft saved after the clear un-clears it.
  assert.equal(effectiveNewEtc({ ...base, newEtcDraft: 175, newEtcClearedAt: AT }), 175);
});

// ── History rows: submittedAt was null, and four readers disagreed (2026-09-14) ─
//
// The Power BI backfill (and Excel restores) wrote needsReview:false rows with no
// submittedAt. The page counted any row of a historical month as confirmed; the
// freeze, validation, the export and effectiveNewEtc read submittedAt alone. On
// reopen the cells arrived pre-filled while validation demanded N values and the
// freeze re-derived the zero-hour cells at priorEtc.
test("a LOCKED history row with no stamp is confirmed for every reader", () => {
  const r: Row = { needsReview: false, newEtc: 77, newEtcDraft: null, newEtcClearedAt: null, submittedAt: null, priorEtc: 100, hoursWorked: 0 };
  assert.equal(isConfirmedEntry(r), true);
  assert.equal(confirmedNewEtc(r), 77);
  assert.equal(effectiveNewEtc(r), 77); // NOT priorEtc (the zero-hours carry-forward)
  assert.equal(seedOf(r), "77"); // the export and the disabled cell both print the stored figure
  assert.equal(isNewEtcDecided(r), true);
});

test("a REOPENED history row with no stamp is honestly unconfirmed for every reader — the same answer, not four", () => {
  // This is the state scripts/backfill-etc-submitted-at.ts exists to remove, and the
  // state sync-etc-history.ts no longer produces. Until it runs, the readers must at
  // least AGREE: the cell is blank/yellow, validation asks for a figure, and the
  // freeze would write the suggestion — rather than a pre-filled cell over a blocked
  // submission.
  const r: Row = { needsReview: true, newEtc: 77, newEtcDraft: null, newEtcClearedAt: null, submittedAt: null, priorEtc: 100, hoursWorked: 40 };
  assert.equal(isConfirmedEntry(r), false);
  assert.equal(confirmedNewEtc(r), null);
  assert.equal(seedOf(r), "");
  assert.equal(isNewEtcDecided(r), false);
  assert.equal(effectiveNewEtc(r), freezeOf(r));
  assert.equal(effectiveNewEtc(r), 60); // the suggestion — what a blank submits as
});

test("a REOPENED history row STAMPED by the backfill / the sync reads as confirmed everywhere", () => {
  const r: Row = {
    needsReview: true,
    newEtc: 77,
    newEtcDraft: null,
    newEtcClearedAt: null,
    submittedAt: historyConfirmedAt("2026-06"),
    priorEtc: 100,
    hoursWorked: 40,
  };
  assert.equal(isConfirmedEntry(r), true);
  assert.equal(seedOf(r), "77");
  assert.equal(isNewEtcDecided(r), true);
  assert.equal(effectiveNewEtc(r), 77);
  assert.equal(freezeOf(r), 77); // a no-edit resubmit writes 77 back, not the suggestion
});

test("read == seed == freeze across the full state space, hours rows", () => {
  const AT2 = new Date("2026-06-30T23:59:59.999Z");
  let checked = 0;
  for (const needsReview of [true, false]) {
    // A frozen row never carries a draft — the freeze nulls it ("consumed by the
    // submission") — so that half of the space is not a state the app can reach.
    for (const newEtcDraft of needsReview ? [null, 175, 0] : [null]) {
      for (const submittedAt of [null, AT2]) {
        for (const newEtcClearedAt of [null, AT2]) {
          const r: Row = { needsReview, newEtc: 160, newEtcDraft, newEtcClearedAt, submittedAt, priorEtc: 148, hoursWorked: 54.5 };
          const shown = seedOf(r);
          if (shown !== "") assert.equal(effectiveNewEtc(r), Number(shown), JSON.stringify(r));
          assert.equal(isNewEtcDecided(r), shown !== "" || !needsReview, JSON.stringify(r));
          if (needsReview) assert.equal(effectiveNewEtc(r), freezeOf(r), JSON.stringify(r));
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 3 * 2 * 2 + 1 * 2 * 2);
});

// ── Parts Cost: the fee snapshot and the freeze take the same rule ──────────
test("read == freeze for a Parts Cost row on a breakout month, live halves included", () => {
  const partsRow = (o: Partial<Row>): Row => ({
    needsReview: true,
    newEtc: 59_000,
    newEtcDraft: null,
    newEtcClearedAt: null,
    submittedAt: null,
    priorEtc: 80_000,
    hoursWorked: 12_500,
    ...o,
  });
  for (const newEtcDraft of [null, 60_000]) {
    for (const submittedAt of [null, AT]) {
      for (const newEtcClearedAt of [null, AT]) {
        for (const breakoutSum of [null, 61_705]) {
          const r = partsRow({ newEtcDraft, submittedAt, newEtcClearedAt });
          const live = { breakoutInScope: true, breakoutSum };
          // getExecutionEtcByJob (the snapshot) and submitEtcEntriesInTx (the freeze)
          // both call partsCostEffectiveNewEtc; the grid seeds from partsCostCellState.
          const state = partsCostCellState(r, live, { locked: false, monthComplete: true });
          const shown = newEtcSeedText(state);
          if (shown !== "") assert.equal(partsCostEffectiveNewEtc(r, live), Number(shown), JSON.stringify({ ...r, breakoutSum }));
        }
      }
    }
  }
  // The headline case: a reopened month, no new edit, invoices drifted. The manager's
  // $59,000 is what the snapshot stores AND what the freeze writes — not $61,705.
  const reopened = partsRow({ submittedAt: AT });
  assert.equal(partsCostEffectiveNewEtc(reopened, { breakoutInScope: true, breakoutSum: 61_705 }), 59_000);
});

test("a frozen row is its stored figure, whatever the other columns say", () => {
  assert.equal(
    effectiveNewEtc({
      needsReview: false,
      newEtc: 400,
      newEtcDraft: 175,
      newEtcClearedAt: AT,
      submittedAt: AT,
      priorEtc: 191.5,
      hoursWorked: 178.58,
    }),
    400,
  );
});
