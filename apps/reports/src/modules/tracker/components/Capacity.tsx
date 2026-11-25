"use client";

import { useState, useTransition } from "react";
import {
  BUTTON_COMPACT,
  BUTTON_PRIMARY,
  CARD_BASE,
  INPUT,
  LABEL,
  TABLE_HEADER_ROW,
  TABLE_ROW_HOVER,
} from "@/components/ui/classnames";
import {
  addHolidayAction,
  addTimeOffAction,
  removeHolidayAction,
  removeTimeOffAction,
  setGlobalHoursAction,
  setPersonHoursAction,
  type ActionResult,
} from "../actions";
import type { CapacityOverview, PersonCapacity } from "../service/people";
import { shortDate } from "./format";

// How much project work fits in a day, per person, and the days that are off. These are the
// forecast's inputs about people, so every change here moves forecast dates.

const SMALL_INPUT =
  "rounded-md border border-sdc-border bg-white px-2 py-1.5 text-sm text-sdc-navy focus:border-sdc-blue focus:outline-none";

function useRun() {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  function run(work: () => Promise<ActionResult>, done?: () => void) {
    setError("");
    start(async () => {
      const res = await work();
      if (!res.ok) return setError(res.error);
      done?.();
    });
  }
  return { error, setError, pending, run };
}

function HoursCell({ person, canManage }: { person: PersonCapacity; canManage: boolean }) {
  const [value, setValue] = useState(person.ownHoursPerDay?.toString() ?? "");
  const { error, setError, pending, run } = useRun();
  if (!canManage) {
    return (
      <>
        {person.hoursPerDay} h{person.ownHoursPerDay == null && <span className="text-sdc-gray-600"> (default)</span>}
      </>
    );
  }
  function save() {
    const next = value.trim() === "" ? null : Number(value);
    if (next === person.ownHoursPerDay) return;
    if (next !== null && !Number.isFinite(next)) return setError("Enter a number of hours.");
    run(() => setPersonHoursAction(person.id, next));
  }
  return (
    <span className="inline-flex flex-col items-center">
      <input
        aria-label={`Project hours a day for ${person.name}`}
        inputMode="decimal"
        value={value}
        disabled={pending}
        placeholder={`${person.hoursPerDay} (default)`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className={`${SMALL_INPUT} w-28 text-center`}
      />
      {error && <span className="mt-1 max-w-[12rem] text-xs text-sdc-red-text">{error}</span>}
    </span>
  );
}

function TimeOff({ person, canChange }: { person: PersonCapacity; canChange: boolean }) {
  const [adding, setAdding] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [half, setHalf] = useState(false);
  const [note, setNote] = useState("");
  const { error, pending, run } = useRun();

  return (
    <div className="space-y-1 text-left">
      {person.timeOff.map((o) => (
        <div key={o.id} className="flex items-center justify-between gap-2 text-xs">
          <span>
            {shortDate(o.start)}
            {o.end !== o.start && ` to ${shortDate(o.end)}`}
            {o.dayPortion < 1 && ` (${Math.round(o.dayPortion * 100)}% of the day)`}
            {o.note && <span className="text-sdc-gray-600"> · {o.note}</span>}
          </span>
          {canChange && (
            <button
              type="button"
              disabled={pending}
              className={BUTTON_COMPACT}
              onClick={() => run(() => removeTimeOffAction(o.id))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {person.timeOff.length === 0 && !adding && <span className="text-xs text-sdc-gray-400">None</span>}
      {canChange &&
        (adding ? (
          <form
            className="flex flex-wrap items-end gap-2 pt-1 text-xs text-sdc-gray-600"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  addTimeOffAction({
                    personId: person.id,
                    start,
                    end: end || start,
                    dayPortion: half ? 0.5 : 1,
                    note: note || null,
                  }),
                () => {
                  setAdding(false);
                  setStart("");
                  setEnd("");
                  setNote("");
                  setHalf(false);
                },
              );
            }}
          >
            <label className="flex flex-col gap-1">
              From
              <input
                required
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className={SMALL_INPUT}
              />
            </label>
            <label className="flex flex-col gap-1">
              To
              <input
                type="date"
                value={end}
                min={start}
                onChange={(e) => setEnd(e.target.value)}
                className={SMALL_INPUT}
              />
            </label>
            <label className="flex items-center gap-1 pb-2">
              <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} /> Half days
            </label>
            <label className="flex min-w-[8rem] flex-1 flex-col gap-1">
              Note
              <input value={note} onChange={(e) => setNote(e.target.value)} className={SMALL_INPUT} />
            </label>
            <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
              Add
            </button>
            <button type="button" className={BUTTON_COMPACT} onClick={() => setAdding(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className={BUTTON_COMPACT} onClick={() => setAdding(true)}>
            Add time off
          </button>
        ))}
      {error && <p className="text-xs text-sdc-red-text">{error}</p>}
    </div>
  );
}

export function Capacity({ overview, canEdit }: { overview: CapacityOverview; canEdit: boolean }) {
  const canManage = canEdit && overview.canManage;
  const [globalHours, setGlobalHours] = useState(overview.globalHoursPerDay.toString());
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const { error, setError, pending, run } = useRun();

  return (
    <div className="space-y-4">
      <section className={`${CARD_BASE} p-4`}>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wider text-sdc-gray-600">A normal day</h2>
        <p className="mb-3 max-w-3xl text-sm text-sdc-gray-600">
          How many hours of project work fit in a working day, once meetings and interruptions are taken out. Estimate
          sizes are built on this: &ldquo;1 Day&rdquo; means this many hours. It applies to everyone who has no figure
          of their own below.
        </p>
        {canManage ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const next = Number(globalHours);
              if (!Number.isFinite(next)) return setError("Enter a number of hours.");
              run(() => setGlobalHoursAction(next));
            }}
          >
            <label className="flex flex-col gap-1">
              <span className={LABEL}>Project hours a day</span>
              <input
                inputMode="decimal"
                value={globalHours}
                onChange={(e) => setGlobalHours(e.target.value)}
                className={`${INPUT} w-32`}
              />
            </label>
            <button
              type="submit"
              disabled={pending || Number(globalHours) === overview.globalHoursPerDay}
              className={BUTTON_PRIMARY}
            >
              Save
            </button>
          </form>
        ) : (
          <p className="text-sm font-semibold text-sdc-navy">{overview.globalHoursPerDay} hours</p>
        )}
      </section>

      <section className={`${CARD_BASE} overflow-x-auto`}>
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className={TABLE_HEADER_ROW}>
              <th className="px-3 py-2.5 text-left">Person</th>
              <th className="px-3 py-2.5">Project hours a day</th>
              <th className="px-3 py-2.5 text-left">Time off coming up</th>
            </tr>
          </thead>
          <tbody>
            {overview.people.map((p) => (
              <tr key={p.id} className={`border-b border-sdc-border-soft align-top ${TABLE_ROW_HOVER}`}>
                <td className="px-3 py-2.5">
                  <span className="font-semibold text-sdc-navy">{p.name}</span>
                  <div className="text-xs text-sdc-gray-600">{p.email}</div>
                </td>
                <td className="px-3 py-2.5 text-center">
                  <HoursCell person={p} canManage={canManage} />
                </td>
                <td className="px-3 py-2.5">
                  <TimeOff person={p} canChange={canEdit && (canManage || p.id === overview.viewerPersonId)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canManage && (
          <p className="px-3 py-2 text-xs text-sdc-gray-600">
            Leave a person&apos;s hours empty to use the default. Give a lower figure to someone who spends most of
            their day on work that is not in the tracker.
          </p>
        )}
      </section>

      <section className={`${CARD_BASE} p-4`}>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-sdc-gray-600">
          Company holidays coming up
        </h2>
        {overview.holidays.length === 0 ? (
          <p className="text-sm text-sdc-gray-600">None entered. The forecast treats every weekday as a working day.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {overview.holidays.map((h) => (
              <li key={h.date} className="flex items-center justify-between gap-2">
                <span>
                  <strong className="text-sdc-navy">{shortDate(h.date)}</strong>{" "}
                  <span className="text-sdc-gray-600">{h.name}</span>
                </span>
                {canManage && (
                  <button
                    type="button"
                    disabled={pending}
                    className={BUTTON_COMPACT}
                    onClick={() => run(() => removeHolidayAction(h.date))}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && (
          <form
            className="mt-3 flex flex-wrap items-end gap-2 border-t border-sdc-border-soft pt-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => addHolidayAction({ date: holidayDate, name: holidayName }),
                () => {
                  setHolidayDate("");
                  setHolidayName("");
                },
              );
            }}
          >
            <label className="flex flex-col gap-1 text-xs text-sdc-gray-600">
              Date
              <input
                required
                type="date"
                value={holidayDate}
                onChange={(e) => setHolidayDate(e.target.value)}
                className={SMALL_INPUT}
              />
            </label>
            <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-sdc-gray-600">
              Name
              <input
                required
                value={holidayName}
                onChange={(e) => setHolidayName(e.target.value)}
                className={SMALL_INPUT}
              />
            </label>
            <button type="submit" disabled={pending} className={BUTTON_COMPACT}>
              Add holiday
            </button>
          </form>
        )}
      </section>
      {error && <p className="text-sm text-sdc-red-text">{error}</p>}
    </div>
  );
}
