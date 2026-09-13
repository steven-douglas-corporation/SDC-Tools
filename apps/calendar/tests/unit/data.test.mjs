// Seed-data generators from src/data.js: SDC holidays, biweekly paydays,
// birthdays. All pure; the module has no side effects at load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holidaysForYear, paydaysForYear, birthdaysForYear } from '../../src/data.js';
import { ymd, daysBetween } from '../../src/utils.js';

const byTitle = (list) => Object.fromEntries(list.map((h) => [h.title, ymd(h.date)]));

test('holidaysForYear computes fixed and nth-weekday holidays for 2026', () => {
  const h = byTitle(holidaysForYear(2026));
  assert.equal(h["New Year's Day"], '2026-01-01');
  assert.equal(h['Memorial Day'], '2026-05-25'); // last Monday of May
  assert.equal(h['Labor Day'], '2026-09-07'); // first Monday of September
  assert.equal(h['Thanksgiving Day'], '2026-11-26'); // fourth Thursday of November
  assert.equal(h['Day After Thanksgiving (SDC)'], '2026-11-27');
  assert.equal(h['Easter (Good Friday Observed)'], '2026-04-03');
  assert.equal(h['Christmas Eve'], '2026-12-24');
  assert.equal(h['Christmas Day'], '2026-12-25');
});

test('holidaysForYear observes Independence Day around weekends', () => {
  // 4 Jul 2026 is a Saturday: observed on Friday and Monday.
  const h26 = byTitle(holidaysForYear(2026));
  assert.equal(h26['Independence Day (observed Fri)'], '2026-07-03');
  assert.equal(h26['Independence Day (observed Mon)'], '2026-07-06');
  // 4 Jul 2027 is a Sunday: observed on Monday.
  assert.equal(byTitle(holidaysForYear(2027))['Independence Day (observed)'], '2027-07-05');
  // 4 Jul 2025 is a Friday: taken on the day.
  assert.equal(byTitle(holidaysForYear(2025))['Independence Day'], '2025-07-04');
});

test('every holiday is an all-day seeded holiday-category event', () => {
  for (const h of holidaysForYear(2026)) {
    assert.equal(h.category, 'holiday');
    assert.equal(h.allDay, true);
    assert.equal(h.seeded, true);
    assert.ok(['federal', 'sdc'].includes(h.kind), `${h.title} has kind ${h.kind}`);
  }
});

test('paydaysForYear is every other Friday anchored on 9 Jan 2026', () => {
  const p26 = paydaysForYear(2026);
  assert.equal(ymd(p26[0].date), '2026-01-09');
  assert.equal(p26.length, 26);
  assert.ok(p26.every((p) => p.date.getDay() === 5 && p.date.getFullYear() === 2026));
  for (let i = 1; i < p26.length; i++) assert.equal(daysBetween(p26[i - 1].date, p26[i].date), 14);

  // Walking the anchor backwards lands on the right Fridays in an earlier year.
  const p25 = paydaysForYear(2025);
  assert.equal(ymd(p25[0].date), '2025-01-10');
  assert.equal(p25.length, 26);
  assert.ok(p25.every((p) => p.date.getDay() === 5 && p.date.getFullYear() === 2025));
  assert.ok(p25.every((p) => p.category === 'payday' && p.allDay && p.seeded));
});

test('birthdaysForYear accepts both employee field spellings', () => {
  const out = birthdaysForYear(2026, [
    { name: 'Ada', role: 'Eng', bMonth: 3, bDay: 9 },
    { name: 'Bob', role: 'Ops', birth_month: 12, birth_day: 31 },
  ]);
  assert.deepEqual(
    out.map((b) => [b.title, ymd(b.date)]),
    [
      ["Ada's Birthday", '2026-03-09'],
      ["Bob's Birthday", '2026-12-31'],
    ],
  );
  assert.equal(out[0].category, 'birthday');
  assert.deepEqual(out[0].meta, { role: 'Eng', name: 'Ada' });
});
