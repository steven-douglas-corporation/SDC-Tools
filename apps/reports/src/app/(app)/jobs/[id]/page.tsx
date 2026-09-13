import { prisma } from "@/lib/prisma";
import { suggestNewEtc, calcHoursLeft, currentMonth } from "@/lib/etc";
import { SECTIONS } from "@/lib/sections";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { PageTitle, SectionTitle } from "@/components/ui/Typography";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PillLinks } from "@/components/ui/PillLinks";
import { card, INPUT, BUTTON_PRIMARY, BUTTON_SECONDARY, LABEL, TABLE_HEADER_ROW, TABLE_GRID, TABLE_CARD } from "@/components/ui/classnames";
import { hours as fmtHours, usd } from "@/components/ui/format";
import { saveJobTask, deleteJobTask } from "@/lib/jobtask-actions";
import { ProjectReleasePanel } from "@/components/ProjectReleasePanel";
import { ConfirmSubmit } from "@/components/ConfirmSubmit";
import { Fragment } from "react";

// Section code -> full name (e.g. "10-211" -> "ME General"), for a tooltip on
// the raw codes printed in the Estimated by Section tab.
const SECTION_NAME_BY_CODE = new Map(SECTIONS.map((s) => [s.code, s.name]));

const TABS = [
  { key: "etc", label: "ETC & Sections" },
  { key: "actual", label: "Actual Hours" },
  { key: "estimate", label: "Estimated by Section" },
  { key: "assign", label: "Assignments" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default async function JobDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ month?: string; tab?: string }>;
}) {
  const { id } = await params;
  const { month: monthParam, tab: tabParam } = await searchParams;
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) notFound();
  const job = await prisma.job.findUnique({ where: { id: jobId } });
  if (!job) notFound();

  const tab: TabKey = (TABS.find((t) => t.key === tabParam)?.key ?? "etc") as TabKey;

  const [estimatedHours, tasks, monthlyActualHours, projectRelease] = await Promise.all([
    prisma.estimatedHours.findMany({ where: { jobId }, orderBy: { section: "asc" } }),
    prisma.jobTask.findMany({ where: { jobId }, orderBy: { slot: "asc" } }),
    prisma.jobMonthlyActualHours.findMany({ where: { jobId }, orderBy: { month: "desc" } }),
    prisma.projectRelease.findUnique({ where: { jobId } }),
  ]);

  // ui/format owns money formatting (§39.13) — this was a seventh local copy.
  const currency = (n: number | null) => (n == null ? "—" : usd(n));
  const formatDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");

  const availableMonths = await prisma.etcEntry.findMany({
    where: { jobId },
    distinct: ["month"],
    select: { month: true },
    orderBy: { month: "desc" },
  });
  // Default to the most recent month with actual data, not blindly today's calendar
  // month — otherwise a job with only historical entries always looks empty on load.
  const month = monthParam || availableMonths[0]?.month || currentMonth();
  const entries = await prisma.etcEntry.findMany({
    where: { jobId, month },
    orderBy: { section: "asc" },
  });

  const needsReviewCount = entries.filter((e) => e.needsReview).length;
  const totalWorked = entries.reduce((sum, e) => sum + Number(e.hoursWorked), 0);

  async function addEntry(formData: FormData) {
    "use server";
    const section = String(formData.get("section"));
    const priorEtc = Number(formData.get("priorEtc"));
    const hoursWorked = Number(formData.get("hoursWorked") || 0);
    const entryMonth = String(formData.get("month"));
    const suggested = suggestNewEtc(priorEtc, hoursWorked);

    await prisma.etcEntry.upsert({
      where: { jobId_section_month: { jobId, section, month: entryMonth } },
      update: { priorEtc, hoursWorked, hoursLeftCalc: calcHoursLeft(priorEtc, hoursWorked), newEtc: suggested },
      create: {
        jobId,
        section,
        month: entryMonth,
        priorEtc,
        hoursWorked,
        hoursLeftCalc: calcHoursLeft(priorEtc, hoursWorked),
        newEtc: suggested,
        needsReview: true,
      },
    });
    revalidatePath(`/jobs/${jobId}`);
  }

  async function confirmEntry(formData: FormData) {
    "use server";
    const entryId = Number(formData.get("entryId"));
    const newEtc = Number(formData.get("newEtc"));
    await prisma.etcEntry.update({
      where: { id: entryId },
      data: { newEtc, needsReview: false, submittedAt: new Date() },
    });
    revalidatePath(`/jobs/${jobId}`);
  }

  // Mirrors the legacy "Actual Hours Override" tab: lets someone correct a
  // month's Power BI-synced hours by hand when the upstream feed is wrong
  // (e.g. Paylocity coded time to "Not Defined" instead of the real job).
  // syncActualHoursFromPowerBi() skips overridden rows on future syncs.
  async function overrideMonthlyActualHours(formData: FormData) {
    "use server";
    const rowId = Number(formData.get("rowId"));
    const newHours = Number(formData.get("newHours"));
    const note = String(formData.get("note") || "").trim() || null;
    await prisma.jobMonthlyActualHours.update({
      where: { id: rowId },
      data: { actualHours: newHours, overridden: true, overriddenNote: note, overriddenAt: new Date() },
    });
    revalidatePath(`/jobs/${jobId}`);
  }

  async function revertOverride(formData: FormData) {
    "use server";
    const rowId = Number(formData.get("rowId"));
    await prisma.jobMonthlyActualHours.update({
      where: { id: rowId },
      data: { overridden: false, overriddenNote: null, overriddenAt: null },
    });
    revalidatePath(`/jobs/${jobId}`);
  }

  const tabLinks = TABS.map((t) => ({
    key: t.key,
    label: t.label,
    href: `/jobs/${jobId}?tab=${t.key}&month=${month}`,
    active: t.key === tab,
  }));

  return (
    <div className="mx-auto w-full max-w-5xl p-8">
      {/* Persistent header — always visible regardless of tab */}
      <div className={`${card("p-5")} mb-6`}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <p className="font-mono text-xs text-sdc-gray-400">
              #{job.jobId}
              {job.customer && <> · {job.customer}</>}
              {job.type && <> · {job.type}</>}
            </p>
            <PageTitle>{job.jobName}</PageTitle>
          </div>
          <StatusBadge variant={job.status === "Complete" ? "complete" : "active"}>{job.status}</StatusBadge>
        </div>
        {estimatedHours.length === 0 && !job.totEtoSyncedAt && (
          <p className="mb-4 rounded-lg border border-sdc-yellow bg-sdc-yellow-bg/40 px-3 py-2 text-xs text-sdc-yellow-text">
            No TotalETO or Power BI data has synced for this job yet. If it was just created, this is expected until it
            also exists upstream with a matching Job Id — try a sync again once it does, or double-check the Job Id
            for a typo.
          </p>
        )}
        {job.startDate && (
          <p className="mb-4 text-xs text-sdc-muted">
            Start: {formatDate(job.startDate)}
            {job.completeDate && <> · Complete: {formatDate(job.completeDate)}</>} · Source: {job.source}
          </p>
        )}
        {(job.costQuoted != null || job.costActualHistorical != null) && (
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">QUOTED COST</p>
              <p className="font-mono text-lg font-bold text-sdc-navy">{currency(job.costQuoted ? Number(job.costQuoted) : null)}</p>
            </div>
            <div className="rounded-lg border border-sdc-border-soft p-3">
              <p className="text-note text-sdc-gray-400">ACTUAL COST</p>
              <p className="font-mono text-lg font-bold text-sdc-navy">
                {currency(job.costActualHistorical ? Number(job.costActualHistorical) : null)}
              </p>
            </div>
          </div>
        )}
      </div>

      <ProjectReleasePanel jobId={jobId} jobName={job.jobName} release={projectRelease} />

      <div className="mb-6 inline-flex gap-1 rounded-lg bg-sdc-gray-100 p-1">
        {tabLinks.map((t) => (
          <a
            key={t.key}
            href={t.href}
            className={`rounded-md px-3.5 py-2 text-sm font-medium motion-interactive ${
              t.active ? "bg-white text-sdc-blue-dark shadow-sm" : "text-sdc-gray-600 hover:text-sdc-navy"
            }`}
          >
            {t.label}
          </a>
        ))}
      </div>

      {tab === "etc" && (
        <>
          <div className="mb-6 grid grid-cols-3 gap-4">
            <div className={card("p-4")}>
              <p className="text-2xl font-bold text-sdc-blue">{entries.length}</p>
              <p className="text-xs text-sdc-gray-600">Sections tracked</p>
            </div>
            <div className={card("p-4")}>
              <p className="text-2xl font-bold text-sdc-blue">{fmtHours(totalWorked)}</p>
              <p className="text-xs text-sdc-gray-600">Hours worked ({month})</p>
            </div>
            <div className={needsReviewCount > 0 ? `${card("p-4")} border-sdc-yellow bg-sdc-yellow-bg/40` : card("p-4")}>
              <p className={`text-2xl font-bold ${needsReviewCount > 0 ? "text-sdc-yellow-text" : "text-sdc-blue"}`}>{needsReviewCount}</p>
              <p className="text-xs text-sdc-gray-600">Needs review</p>
            </div>
          </div>

          <div className="mb-6 flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-sdc-muted">Month:</span>
            {availableMonths.length === 0 && <span className="text-xs text-sdc-gray-400">no ETC history yet</span>}
            <PillLinks
              items={availableMonths.map((m) => ({
                key: m.month,
                label: m.month,
                href: `/jobs/${jobId}?month=${m.month}&tab=etc`,
                active: m.month === month,
              }))}
            />
            {!availableMonths.some((m) => m.month === month) && (
              <StatusBadge variant="active">{month} (current, no entries)</StatusBadge>
            )}
          </div>

          <SectionTitle className="mb-2">ETC Entries — {month}</SectionTitle>
          <div className={`${card("p-0")} mb-6 overflow-hidden`}>
            <div className="divide-y divide-sdc-border-soft">
              {entries.length === 0 && <p className="p-5 text-sm text-sdc-gray-400">No sections entered yet for {month}.</p>}
              {entries.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                  <div>
                    <p className="font-medium text-sdc-navy">{entry.section}</p>
                    <p className="text-sdc-muted">
                      Prior ETC <span className="font-mono font-medium text-sdc-navy">{entry.priorEtc.toString()}</span> − Worked{" "}
                      <span className="font-mono font-medium text-sdc-navy">{entry.hoursWorked.toString()}</span> = Suggested{" "}
                      <span className="font-mono font-medium text-sdc-navy">{entry.hoursLeftCalc.toString()}</span>
                    </p>
                  </div>
                  <form action={confirmEntry} className="flex items-center gap-2">
                    <input type="hidden" name="entryId" value={entry.id} />
                    <input
                      type="number"
                      step="0.01"
                      name="newEtc"
                      defaultValue={entry.newEtc.toString()}
                      className={`w-24 ${INPUT}`}
                    />
                    <StatusBadge variant={entry.needsReview ? "needsReview" : "confirmed"}>
                      {entry.needsReview ? "Needs review" : "Confirmed"}
                    </StatusBadge>
                    <button type="submit" className={`${BUTTON_PRIMARY} px-3 py-1 text-xs`}>
                      Confirm
                    </button>
                  </form>
                </div>
              ))}
            </div>
          </div>

          <SectionTitle className="mb-2">Add / Update Section ({month})</SectionTitle>
          <form action={addEntry} className={`${card("p-4")} flex flex-wrap items-end gap-3`}>
            <input type="hidden" name="month" value={month} />
            <div>
              <label className="text-xs font-medium text-sdc-gray-600">Section</label>
              <input name="section" required placeholder="10-111" className={`mt-1 block w-28 ${INPUT}`} />
            </div>
            <div>
              <label className="text-xs font-medium text-sdc-gray-600">Prior ETC (hrs)</label>
              <input type="number" step="0.01" name="priorEtc" required className={`mt-1 block w-28 ${INPUT}`} />
            </div>
            <div>
              <label className="text-xs font-medium text-sdc-gray-600">Hours Worked This Month</label>
              <input type="number" step="0.01" name="hoursWorked" defaultValue={0} className={`mt-1 block w-36 ${INPUT}`} />
            </div>
            <button type="submit" className={BUTTON_PRIMARY}>
              Save
            </button>
          </form>
          <p className="mt-2 text-xs text-sdc-gray-400">
            Hours worked is manually entered for now (Paylocity sync pending confirmation with John).
          </p>
        </>
      )}

      {tab === "actual" && (
        <>
          {job.totEtoSyncedAt && (
            <div className={`${card("p-5")} mb-6`}>
              <div className="mb-3 flex items-center justify-between">
                <SectionTitle>Live from TotalETO</SectionTitle>
                <span className="text-xs text-sdc-gray-400">
                  Synced: {job.totEtoSyncedAt.toISOString().slice(0, 16).replace("T", " ")}
                </span>
              </div>
              <div className="grid grid-cols-4 gap-4 text-sm">
                <div>
                  <p className="font-mono text-lg font-bold text-sdc-blue">{job.totEtoEstEngHours?.toString() ?? "—"}</p>
                  <p className="text-xs text-sdc-gray-600">Est. Engineering Hrs</p>
                </div>
                <div>
                  <p className="font-mono text-lg font-bold text-sdc-blue">{job.totEtoActEngHours?.toString() ?? "—"}</p>
                  <p className="text-xs text-sdc-gray-600">Actual Engineering Hrs</p>
                </div>
                <div>
                  <p className="font-mono text-lg font-bold text-sdc-blue">{job.totEtoEstMfgHours?.toString() ?? "—"}</p>
                  <p className="text-xs text-sdc-gray-600">Est. Mfg Hrs</p>
                </div>
                <div>
                  <p className="font-mono text-lg font-bold text-sdc-blue">{job.totEtoActMfgHours?.toString() ?? "—"}</p>
                  <p className="text-xs text-sdc-gray-600">Actual Mfg Hrs</p>
                </div>
              </div>
            </div>
          )}

          {monthlyActualHours.length > 0 ? (
            <div className={TABLE_CARD}>
              <div className="border-b border-sdc-border-soft px-4 py-3">
                {/* The title used to read "(Power BI)", which is no longer true of most rows:
                    this table is Paylocity-synced for every month the punch feed covers,
                    and only the pre-feed legacy months are still Power BI values. One
                    blanket label cannot say that, so provenance moved to a per-row
                    Source column and the title states the subject only. */}
                <SectionTitle>Actual Hours by Month</SectionTitle>
              </div>
              <table className={`w-full text-sm ${TABLE_GRID}`}>
                <thead>
                  <tr className={TABLE_HEADER_ROW}>
                    <th className="px-4 py-2">Month</th>
                    <th className="px-4 py-2">Actual Hours</th>
                    <th className="px-4 py-2">Source</th>
                    <th className="px-4 py-2">Correction</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyActualHours.map((m, i) => (
                    <tr key={m.id} className={i % 2 === 1 ? "bg-sdc-gray-50/60" : ""}>
                      <td className="px-4 py-2 text-center text-label font-medium text-sdc-navy align-top">{m.month}</td>
                      <td className="px-4 py-2 text-center text-label align-top">
                        {m.actualHours.toString()}
                        {m.overridden && (
                          <span className="ml-2 rounded-full bg-sdc-yellow-bg px-2 py-0.5 text-label font-medium text-sdc-yellow-text">
                            Overridden
                          </span>
                        )}
                        {m.overriddenNote && <p className="mt-0.5 text-label text-sdc-gray-400">{m.overriddenNote}</p>}
                      </td>
                      {/* Read straight off the row rather than assumed, so a legacy
                          month is visibly legacy instead of silently passing as current. */}
                      <td className="px-4 py-2 text-center text-label align-top text-sdc-muted">
                        {m.source === "paylocity_excel"
                          ? "Paylocity"
                          : m.source === "power_bi"
                            ? "Power BI (legacy)"
                            : m.source}
                      </td>
                      <td className="px-4 py-2 text-center text-label align-top">
                        {m.overridden ? (
                          <form action={revertOverride}>
                            <input type="hidden" name="rowId" value={m.id} />
                            <button type="submit" className="text-label text-sdc-muted underline hover:text-sdc-navy">
                              Revert to synced value
                            </button>
                          </form>
                        ) : (
                          <form action={overrideMonthlyActualHours} className="flex items-center justify-center gap-1.5">
                            <input type="hidden" name="rowId" value={m.id} />
                            <input
                              type="number"
                              step="0.01"
                              name="newHours"
                              defaultValue={m.actualHours.toString()}
                              className={`${INPUT} w-24 py-1 text-label`}
                            />
                            <input
                              type="text"
                              name="note"
                              placeholder="Reason (optional)"
                              className={`${INPUT} w-36 py-1 text-label`}
                            />
                            <button type="submit" className={`${BUTTON_PRIMARY} px-2.5 py-1 text-label`}>
                              Override
                            </button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !job.totEtoSyncedAt && <p className="text-sm text-sdc-gray-400">No actual-hours data yet.</p>
          )}
        </>
      )}

      {tab === "estimate" && (
        <>
          <p className="mb-2 text-xs text-sdc-gray-400">
            From the &quot;Estimated Hours&quot; tab — Quoted (original bid), Actual Historical (cumulative as of a
            cutoff date), and Estimate to Complete, per section code.
          </p>
          {estimatedHours.length > 0 ? (
            <div className={TABLE_CARD}>
              <table className={`w-full text-sm ${TABLE_GRID}`}>
                <thead>
                  <tr className={TABLE_HEADER_ROW}>
                    <th className="px-4 py-3">Section</th>
                    <th className="px-4 py-3 text-center">Quoted</th>
                    <th className="px-4 py-3 text-center">Actual Historical</th>
                    <th className="px-4 py-3 text-center">Estimate to Complete</th>
                  </tr>
                </thead>
                <tbody>
                  {estimatedHours.map((eh, i) => (
                    <tr key={eh.id} className={i % 2 === 1 ? "bg-sdc-gray-50/60" : ""}>
                      <td className="px-4 py-2 text-center text-label font-medium text-sdc-navy" title={SECTION_NAME_BY_CODE.get(eh.section)}>{eh.section}</td>
                      <td className="px-4 py-2 text-center text-label">{eh.quotedHours.toString()}</td>
                      <td className="px-4 py-2 text-center text-label">{eh.actualHistoricalHours.toString()}</td>
                      <td className="px-4 py-2 text-center text-label">{eh.estimateToCompleteHours.toString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-sdc-gray-400">No estimated-hours data for this job.</p>
          )}
        </>
      )}

      {tab === "assign" && (
        <>
          <p className="mb-2 text-xs text-sdc-gray-400">
            Per-employee task breakdown from the &quot;ME Name&quot; columns — editable here, replacing the Project
            Planner workbook.
          </p>
          <div className={TABLE_CARD}>
            <table className={`w-full text-sm ${TABLE_GRID}`}>
              <thead>
                <tr className={TABLE_HEADER_ROW}>
                  <th className="px-4 py-3">Task / Person</th>
                  <th className="px-4 py-3">Estimate to Complete (hrs)</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t, i) => (
                  <tr key={t.id} className={i % 2 === 1 ? "bg-sdc-gray-50/60" : ""}>
                    <td className="px-4 py-2 text-center">
                      <input
                        name="taskName"
                        defaultValue={t.taskName}
                        required
                        form={`task-${t.id}`}
                        className={`${INPUT} w-full px-2 py-1 text-center text-label font-medium`}
                        aria-label={`Task name, slot ${t.slot}`}
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input
                        name="hours"
                        type="number"
                        step="0.01"
                        min="0"
                        defaultValue={t.estimateToCompleteHours.toString()}
                        form={`task-${t.id}`}
                        className={`${INPUT} w-28 px-2 py-1 text-center text-label`}
                        aria-label={`Hours, slot ${t.slot}`}
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <div className="flex justify-center gap-2">
                        <button type="submit" form={`task-${t.id}`} className={`${BUTTON_SECONDARY} px-2.5 py-1 text-label`}>
                          Save
                        </button>
                        <ConfirmSubmit
                          form={`task-del-${t.id}`}
                          message={`Delete task "${t.taskName}"? This can't be undone.`}
                          className={`${BUTTON_SECONDARY} px-2.5 py-1 text-label text-sdc-red-text`}
                        >
                          Delete
                        </ConfirmSubmit>
                      </div>
                    </td>
                  </tr>
                ))}
                {tasks.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-5 text-center text-label text-sdc-gray-400">
                      No task assignments for this job yet — add one below.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Row edit forms live outside the table (HTML forbids <form> in <tr>). */}
          {tasks.map((t) => (
            <Fragment key={t.id}>
              <form id={`task-${t.id}`} action={saveJobTask.bind(null, jobId, t.slot)} />
              <form id={`task-del-${t.id}`} action={deleteJobTask.bind(null, t.id)} />
            </Fragment>
          ))}

          <form action={saveJobTask.bind(null, jobId, null)} className={`${card()} mt-4`}>
            <p className="mb-3 text-sm font-semibold text-sdc-navy">Add task assignment</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Task / Person *</span>
                <input name="taskName" required className={INPUT} placeholder="e.g. J. Smith — panel layout" />
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>Estimate to Complete (hrs)</span>
                <input name="hours" type="number" step="0.01" min="0" defaultValue="0" className={INPUT} />
              </label>
              <button type="submit" className={BUTTON_PRIMARY}>
                Add
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
