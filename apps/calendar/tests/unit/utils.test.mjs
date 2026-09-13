// Pure date / time / ICS helpers from src/utils.js. Nothing here touches
// localStorage or the DOM, so the module loads cleanly under node:test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ymd,
  parseYMD,
  startOfWeek,
  getWeekNum,
  fmtTime,
  timeToMin,
  detectConflicts,
  expandRecurring,
  generateICS,
  parseICS,
} from '../../src/utils.js';

test('ymd zero-pads month and day', () => {
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(ymd(new Date(2026, 11, 25)), '2026-12-25');
});

test('parseYMD builds a local-midnight date that round-trips through ymd', () => {
  const d = parseYMD('2026-09-13');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8);
  assert.equal(d.getDate(), 13);
  assert.equal(d.getHours(), 0);
  assert.equal(ymd(d), '2026-09-13');
});

test('startOfWeek honours the configured week-start day', () => {
  const sunday = new Date(2026, 8, 13);
  assert.equal(sunday.getDay(), 0);
  assert.equal(ymd(startOfWeek(sunday, 1)), '2026-09-07'); // Monday start: previous Monday
  assert.equal(ymd(startOfWeek(sunday, 0)), '2026-09-13'); // Sunday start: same day
  assert.equal(ymd(startOfWeek(new Date(2026, 8, 9), 1)), '2026-09-07'); // mid-week
});

test('getWeekNum returns ISO week numbers across year boundaries', () => {
  assert.equal(getWeekNum(new Date(2026, 0, 1)), 1); // Thu 1 Jan 2026 is in week 1
  assert.equal(getWeekNum(new Date(2024, 11, 30)), 1); // Mon 30 Dec 2024 belongs to 2025-W01
  assert.equal(getWeekNum(new Date(2026, 8, 13)), 37);
  assert.equal(getWeekNum(new Date(2027, 0, 1)), 53); // Fri 1 Jan 2027 belongs to 2026-W53
});

test('fmtTime renders HH:MM as a 12-hour clock', () => {
  assert.equal(fmtTime('13:05'), '1:05 PM');
  assert.equal(fmtTime('00:30'), '12:30 AM');
  assert.equal(fmtTime('12:00'), '12:00 PM');
  assert.equal(fmtTime(''), '');
});

test('timeToMin converts HH:MM to minutes since midnight', () => {
  assert.equal(timeToMin('09:30'), 570);
  assert.equal(timeToMin('00:00'), 0);
  assert.equal(timeToMin(''), 0);
});

test('detectConflicts reports overlapping timed events on the same day only', () => {
  const day = new Date(2026, 8, 14);
  const existing = [
    { id: 'a', date: day, time: '09:00', endTime: '10:00' },
    { id: 'b', date: day, time: '11:00', endTime: '12:00' },
    { id: 'c', date: day, allDay: true },
    { id: 'd', date: new Date(2026, 8, 15), time: '09:00', endTime: '10:00' },
  ];
  const ids = (list) => list.map((e) => e.id);

  assert.deepEqual(ids(detectConflicts({ id: 'n', date: day, time: '09:30', endTime: '10:30' }, existing)), ['a']);
  // Touching edges do not overlap.
  assert.deepEqual(detectConflicts({ id: 'n', date: day, time: '10:00', endTime: '11:00' }, existing), []);
  // All-day candidates never conflict.
  assert.deepEqual(detectConflicts({ id: 'n', date: day, allDay: true }, existing), []);
  // An event is not a conflict with itself.
  assert.deepEqual(detectConflicts(existing[0], existing), []);
  // The candidate date may be a YMD string; a missing end time means one hour.
  assert.deepEqual(ids(detectConflicts({ id: 'n', date: '2026-09-14', time: '11:30' }, existing)), ['b']);
});

test('expandRecurring generates weekly instances inside the range', () => {
  const ev = { id: 'w', title: 'Standup', date: new Date(2026, 8, 7), repeat: 'weekly' };
  const out = expandRecurring(ev, new Date(2026, 8, 1), new Date(2026, 8, 30));
  assert.deepEqual(
    out.map((e) => ymd(e.date)),
    ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'],
  );
  assert.ok(out.every((e) => e.isRecurringInstance && e.masterEventId === 'w'));
  assert.equal(out[0].id, 'w-r-2026-09-07');

  const plain = { id: 'x', date: new Date(2026, 8, 7), repeat: 'none' };
  assert.deepEqual(expandRecurring(plain, new Date(2026, 8, 1), new Date(2026, 8, 30)), [plain]);
});

test('generateICS and parseICS round-trip a timed event', () => {
  const ev = {
    id: 'e1',
    title: 'Design Review',
    date: new Date(2026, 8, 14),
    time: '14:30',
    endTime: '15:30',
    location: 'Floor 4',
    description: 'Bring prints',
    repeat: 'weekly',
  };
  const ics = generateICS([ev]);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(ics.includes('DTSTART:20260914T143000'));
  assert.ok(ics.includes('DTEND:20260914T153000'));
  assert.ok(ics.includes('RRULE:FREQ=WEEKLY'));

  const [back] = parseICS(ics);
  assert.equal(back.title, 'Design Review');
  assert.equal(ymd(back.date), '2026-09-14');
  assert.equal(back.time, '14:30');
  assert.equal(back.allDay, false);
  assert.equal(back.location, 'Floor 4');
  assert.equal(back.description, 'Bring prints');
});

test('generateICS writes all-day events as DATE values with an exclusive end', () => {
  const ics = generateICS([{ id: 'h', title: 'Holiday', date: new Date(2026, 11, 25), allDay: true }]);
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261225'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261226'));

  const [back] = parseICS(ics);
  assert.equal(back.allDay, true);
  assert.equal(back.time, '');
  assert.equal(ymd(back.date), '2026-12-25');
});
