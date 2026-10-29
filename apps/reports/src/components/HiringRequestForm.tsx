"use client";

import { useState, useTransition } from "react";
import { EMPLOYEE_TEAMS } from "@/lib/employee-teams";
import { workforceGroupForCardKey } from "@/lib/employee-workforce-groups";
import { createHiringRequest, updateHiringRequest, closeHiringRequest } from "@/lib/hiring-actions";
import { REQUEST_STATUS, REQUESTABLE_TEAMS, isRequestableTeam, type TeamLead } from "@/lib/hiring-requests";
import type { HiringPosition } from "@/lib/hiring-positions";

// The hire request form (2026-10-29), for both "Request a hire" and editing a
// request. A manager says what they need and who the hiring manager will be;
// the recruiter files it in Paylocity. No status to pick: a request is just
// requested until it is closed. The team follows the chosen team lead until
// someone picks a team by hand, so the usual case is three fields.

const INPUT = "h-9 w-full rounded-lg border border-sdc-border bg-white px-2.5 text-sm text-sdc-navy outline-none focus:border-sdc-blue";
const LABEL = "text-xs font-semibold uppercase tracking-wide text-sdc-muted";

function dateInput(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "";
}

export function HiringRequestForm({
  request,
  leads,
  posting,
  onCreated,
  onUpdated,
  onClosed,
  onCancel,
  initialTeam,
}: {
  /** The request being edited; omitted for a new one. */
  request?: HiringPosition;
  /** A new request started from a team's card on the Org chart (2026-10-29): that team, and its lead if it has exactly one. */
  initialTeam?: string | null;
  leads: TeamLead[];
  /** The Paylocity posting this request looks like it became (lib/hiring-requests.ts findPostingForRequest), if any. */
  posting?: HiringPosition | null;
  onCreated?: (position: HiringPosition) => void;
  onUpdated?: (sourceId: string, patch: Partial<HiringPosition>) => void;
  /** The request was closed (posted, or no longer needed): drop it from the page. */
  onClosed?: (sourceId: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(request?.title ?? "");
  // Raw text, parsed on submit, so the field can be briefly empty while typing.
  const [quantity, setQuantity] = useState(String(request?.quantity ?? 1));
  const startTeam = !request && isRequestableTeam(initialTeam) ? initialTeam! : null;
  const teamLeadsOf = startTeam ? leads.filter((l) => l.team === startTeam) : [];
  const [hiringManagerId, setHiringManagerId] = useState(
    request?.hiringManagerIds[0] ?? (teamLeadsOf.length === 1 ? teamLeadsOf[0].paylocityId : ""),
  );
  const [department, setDepartment] = useState(request?.department ?? startTeam ?? "");
  const [teamPicked, setTeamPicked] = useState(!!request || !!startTeam);
  const [neededBy, setNeededBy] = useState(dateInput(request?.expectedStartDate ?? null));
  const [note, setNote] = useState(request?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // A request naming someone who is no longer a team lead keeps them selectable,
  // or saving would silently swap in the first lead on the list.
  const options =
    hiringManagerId && !leads.some((l) => l.paylocityId === hiringManagerId)
      ? [{ paylocityId: hiringManagerId, name: `Paylocity ID ${hiringManagerId}`, team: null }, ...leads]
      : leads;

  function pickLead(id: string) {
    setHiringManagerId(id);
    const team = leads.find((l) => l.paylocityId === id)?.team;
    if (!teamPicked && isRequestableTeam(team)) setDepartment(team!);
  }

  function submit() {
    setError(null);
    if (!title.trim()) return setError("Position title is required.");
    const n = Number(quantity);
    if (!quantity.trim() || !Number.isInteger(n) || n < 1) return setError("How many must be a whole number of 1 or more.");
    if (!hiringManagerId) return setError("Pick the team lead who will be the hiring manager.");
    if (!isRequestableTeam(department)) return setError("Pick the team this hire is for.");
    const input = { title, quantity: n, department, hiringManagerId, expectedStartDate: neededBy ? new Date(neededBy) : null, note: note.trim() || null };
    startTransition(async () => {
      if (request) {
        const result = await updateHiringRequest(request.sourceId, input);
        if (!result.ok) return setError(result.error);
        onUpdated?.(request.sourceId, {
          title: title.trim(),
          quantity: n,
          remainingQuantity: n,
          department,
          workforceGroup: workforceGroupForCardKey(department),
          hiringManagerIds: [hiringManagerId],
          expectedStartDate: input.expectedStartDate,
          note: input.note,
        });
        onCancel();
        return;
      }
      const result = await createHiringRequest(input);
      if (!result.ok) return setError(result.error);
      onCreated?.({
        sourceId: result.sourceId,
        title: title.trim(),
        status: REQUEST_STATUS,
        subStatus: null,
        // Same as the server: a request never counts toward hiring totals.
        isOpen: false,
        quantity: n,
        filledCount: 0,
        remainingQuantity: n,
        source: "manual",
        workforceGroup: workforceGroupForCardKey(department),
        department,
        hiringManagerIds: [hiringManagerId],
        requestedAt: new Date(),
        note: input.note,
        isManuallyAssigned: true,
        expectedStartDate: input.expectedStartDate,
        isVisible: true,
        functionDescription: null,
        sectionDescription: null,
        workLocDescription: null,
        createdDate: new Date().toLocaleDateString("en-US"),
        createdBy: null,
        modifiedBy: null,
        remote: false,
        internal: false,
      });
      onCancel();
    });
  }

  function close(postedAsJobId?: string) {
    if (!request) return;
    const question = postedAsJobId
      ? `Close the request for "${request.title}"? Paylocity's posting (Job ${postedAsJobId}) takes its place.`
      : `Withdraw the request for "${request.title}"? Use this when the hire is no longer needed.`;
    if (!window.confirm(question)) return;
    setError(null);
    startTransition(async () => {
      const result = await closeHiringRequest(request.sourceId, postedAsJobId);
      if (!result.ok) return setError(result.error);
      onClosed?.(request.sourceId);
    });
  }

  return (
    <form
      className="flex flex-col gap-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {request && posting && (
        <div className="flex flex-col gap-2 rounded-lg border border-sdc-border bg-sdc-blue-light px-3 py-2.5">
          <p className="text-sm text-sdc-navy">
            Looks posted in Paylocity as <span className="font-semibold">{posting.title}</span> (Job {posting.sourceId}
            {posting.createdDate ? `, published ${posting.createdDate}` : ""}).
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => close(posting.sourceId)}
            className="self-start text-sm font-semibold text-sdc-blue hover:underline disabled:opacity-60"
          >
            Close this request
          </button>
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Position title *</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Controls Engineer" className={INPUT} autoFocus={!request} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>How many *</span>
        <input type="number" min={1} step={1} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={`${INPUT} w-24`} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Hiring manager *</span>
        <select value={hiringManagerId} onChange={(e) => pickLead(e.target.value)} className={INPUT}>
          <option value="" disabled>
            Pick a team lead
          </option>
          {options.map((l) => (
            <option key={l.paylocityId} value={l.paylocityId}>
              {l.name}
              {l.team ? ` · ${EMPLOYEE_TEAMS.find((t) => t.schedulerCode === l.team)?.name ?? l.team.charAt(0).toUpperCase() + l.team.slice(1)}` : ""}
            </option>
          ))}
        </select>
        <span className="text-note text-sdc-muted">The team lead named as hiring manager on the Paylocity posting.</span>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Team *</span>
        <select
          value={department}
          onChange={(e) => {
            setDepartment(e.target.value);
            setTeamPicked(true);
          }}
          className={INPUT}
        >
          <option value="" disabled>
            Pick a team
          </option>
          {REQUESTABLE_TEAMS.map((t) => (
            <option key={t.schedulerCode} value={t.schedulerCode}>
              {t.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Needed by</span>
        <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} className={INPUT} />
      </label>

      <label className="flex flex-col gap-1">
        <span className={LABEL}>Note for the recruiter</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={1000}
          rows={3}
          placeholder="Optional: location, remote, must-have skills"
          className="w-full rounded-lg border border-sdc-border bg-white px-2.5 py-2 text-sm text-sdc-navy outline-none focus:border-sdc-blue"
        />
      </label>

      <p className="text-note text-sdc-muted">
        A request doesn&apos;t count toward hiring totals. The Paylocity posting does, once it arrives (usually the day after it&apos;s posted).
      </p>

      {error && (
        <p className="text-note text-sdc-red-text" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {request ? (
          <button type="button" disabled={pending} onClick={() => close()} className="text-sm font-semibold text-sdc-red-text hover:underline disabled:opacity-60">
            Withdraw request
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} className="h-9 rounded-lg border border-sdc-border px-3.5 text-sm font-medium text-sdc-navy hover:bg-sdc-gray-50">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="h-9 rounded-lg bg-sdc-blue px-3.5 text-sm font-semibold text-white motion-interactive hover:brightness-95 disabled:opacity-60"
          >
            {pending ? "Saving…" : request ? "Save changes" : "Request hire"}
          </button>
        </div>
      </div>
    </form>
  );
}
