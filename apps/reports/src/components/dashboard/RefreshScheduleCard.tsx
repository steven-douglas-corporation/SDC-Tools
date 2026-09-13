"use client";

import { useState } from "react";
import type { SourceHealth, SourceHealthReport, SourceState, SourceFamily } from "@/lib/source-health";
import { sortByUrgency } from "@/lib/source-health";

// ── Data source health (rebuilt 2026-09-02) ─────────────────────────────────
//
// Was one wrapping line of chips — "Actual hours · Aug 6, 2:04 PM | Undefined
// hours · Aug 6, 2:04 PM | …" — ten of them, every one the same size and the
// same weight, with the whole diagnosis (data-through date, the failure text,
// the stated wait) hidden in a `title` tooltip. It could tell you something had
// happened. It could not tell you whether to trust the numbers above it, and at
// ten sources it had become a paragraph you skim rather than a status you read.
//
// This is the same information, ranked. Three rules:
//
//   1. THE ANSWER FIRST. A verdict line ("All 10 sources healthy" / "2 sources
//      failed") and a summary strip carry the whole state of the system before
//      any individual source is named. If something is wrong the panel stops
//      looking calm — tone comes from the worst state present, not from an
//      average.
//   2. PROBLEMS ARE NOT PEERS OF NON-PROBLEMS. Failed sources render first, as
//      full rows with their error, when they last succeeded and whether stale
//      data is still on screen. Healthy sources collapse into a compact list
//      behind a disclosure when there is anything worse to look at — ten green
//      rows are ten rows of nothing to do.
//   3. STALE IS ITS OWN STATE. See lib/source-health.ts: a source that nobody
//      has failed to refresh, because nobody has refreshed it at all, used to
//      read as green indefinitely. It is now amber on its own terms.
//
// Still deliberately quiet as a container, and still has NO refresh button of
// its own: the one control that starts a pass is "Refresh Data" in the sidebar,
// on every page, and a second copy is a second thing to keep in step.

function timeAgo(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// "Aug 6, 2:04 PM" — local time, since the raw ISO string this replaced read as
// UTC and could misjudge freshness by hours.
function formatClock(d: Date): string {
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Math.round(ms / 100) / 10}s`;
}

function formatSpan(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

// ── The state vocabulary, in one place ──────────────────────────────────────
// Colour is never the only carrier: every state also has a glyph and a word, so
// the panel still reads correctly to someone who cannot separate its red from
// its green — and prints in black and white.
const STATE_UI: Record<SourceState, { label: string; dot: string; chip: string; glyph: string }> = {
  failed: { label: "Failed", dot: "bg-sdc-red", chip: "border-sdc-red-border bg-sdc-red-bg text-sdc-red-text", glyph: "✕" },
  stale: { label: "Stale", dot: "bg-sdc-yellow", chip: "border-sdc-yellow/70 bg-sdc-yellow-bg text-sdc-yellow-text", glyph: "!" },
  never: { label: "Never run", dot: "bg-sdc-gray-400", chip: "border-sdc-border bg-sdc-gray-100 text-sdc-gray-600", glyph: "–" },
  waiting: { label: "Waiting", dot: "bg-sdc-yellow", chip: "border-sdc-yellow/70 bg-sdc-yellow-bg text-sdc-yellow-text", glyph: "⏸" },
  refreshing: { label: "Refreshing", dot: "bg-sdc-blue", chip: "border-sdc-blue-100 bg-sdc-blue-light text-sdc-blue-dark", glyph: "↻" },
  healthy: { label: "Healthy", dot: "bg-sdc-green", chip: "border-sdc-green/40 bg-sdc-green-bg text-sdc-green-text", glyph: "✓" },
};

// Family tags are informational, not a fifth status colour — one neutral
// treatment, so "all four Total ETO sources are red" is carried by the red and
// the tag merely names the system they share.
const FAMILY_UI: Record<SourceFamily, string> = {
  "Total ETO": "border-sdc-border bg-white text-sdc-muted",
  Paylocity: "border-sdc-border bg-white text-sdc-muted",
  "Monthly file": "border-sdc-border bg-white text-sdc-muted",
  "App-owned": "border-sdc-border bg-white text-sdc-muted",
};

function StatusChip({ state }: { state: SourceState }) {
  const ui = STATE_UI[state];
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.65rem] font-semibold ${ui.chip}`}>
      <span aria-hidden>{ui.glyph}</span>
      {ui.label}
    </span>
  );
}

/** The last few passes for one source, oldest → newest, left to right. */
function HistoryStrip({ history }: { history: SourceHealth["history"] }) {
  if (history.length === 0) return null;
  const recent = history.slice(0, 5).reverse();
  const title = recent.map((h) => `${formatClock(h.at)} — ${h.outcome}`).join("\n");
  return (
    <span className="flex shrink-0 items-center gap-0.5" title={`Last ${recent.length} passes (oldest first)\n${title}`}>
      {recent.map((h, i) => (
        <span
          key={i}
          aria-hidden
          className={`h-2.5 w-1 rounded-[1px] ${h.outcome === "ok" ? "bg-sdc-green" : h.outcome === "failed" ? "bg-sdc-red" : "bg-sdc-border"}`}
        />
      ))}
      <span className="sr-only">
        Last {recent.length} passes: {recent.map((h) => h.outcome).join(", ")}
      </span>
    </span>
  );
}

function Metric({ value, label, tone = "plain" }: { value: string; label: string; tone?: "plain" | "good" | "warn" | "bad" | "busy" }) {
  const valueTone =
    tone === "bad"
      ? "text-sdc-red-text"
      : tone === "warn"
        ? "text-sdc-yellow-text"
        : tone === "good"
          ? "text-sdc-green-text"
          : tone === "busy"
            ? "text-sdc-blue-dark"
            : "text-sdc-navy";
  return (
    <div className="min-w-[5.5rem] flex-1 rounded-lg border border-sdc-border bg-white px-2.5 py-1.5">
      <div className={`text-[0.95rem] font-semibold leading-tight tabular-nums ${valueTone}`}>{value}</div>
      <div className="mt-0.5 text-[0.62rem] font-medium uppercase tracking-wide text-sdc-muted">{label}</div>
    </div>
  );
}

/** One source: the summary line everybody reads, plus the detail an admin opens. */
function SourceRow({ s, dense }: { s: SourceHealth; dense: boolean }) {
  const [open, setOpen] = useState(false);
  const ui = STATE_UI[s.state];
  const duration = formatDuration(s.lastDurationMs);
  const problem = s.state === "failed" || s.state === "stale" || s.state === "never";

  return (
    <div
      className={`rounded-lg border ${
        s.state === "failed"
          ? "border-sdc-red-border bg-sdc-red-bg/50"
          : s.state === "stale" || s.state === "never" || s.state === "waiting"
            ? "border-sdc-yellow/50 bg-sdc-yellow-bg/40"
            : "border-sdc-border bg-white"
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`motion-interactive flex w-full items-center gap-2 rounded-lg px-2.5 text-left hover:bg-sdc-blue-light/40 ${dense ? "py-1" : "py-1.5"}`}
      >
        <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${ui.dot}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-sdc-navy">{s.label}</span>
        <span className={`hidden shrink-0 rounded border px-1 py-0.5 text-[0.6rem] font-medium sm:inline ${FAMILY_UI[s.family]}`}>{s.family}</span>
        {!dense && <StatusChip state={s.state} />}
        <span className="shrink-0 text-[0.68rem] tabular-nums text-sdc-muted">{s.checkedAt ? timeAgo(s.checkedAt) : "never"}</span>
        {duration && <span className="hidden shrink-0 text-[0.68rem] tabular-nums text-sdc-muted md:inline">{duration}</span>}
        <HistoryStrip history={s.history} />
        <span aria-hidden className={`shrink-0 text-[0.6rem] text-sdc-muted ${open ? "rotate-90" : ""} motion-interactive`}>
          ▶
        </span>
      </button>

      {/* The one-line reason, in the row rather than in a tooltip: a failure
          nobody hovers is a failure nobody reads. Clamped to two lines, because
          real failure text runs to hundreds of characters (the DPAPI one that
          broke the sync for weeks is ~440) and four of those side by side turn
          this panel back into the paragraph it replaced. The first line carries
          the diagnosis; the rest is one click away in the detail. */}
      {!open && problem && (s.failure || s.overdueBy != null) && (
        <div className="px-2.5 pb-1.5">
          {/* The clamp is on the paragraph itself, with the padding on this
              wrapper: a max-height that also has to contain padding cuts into
              the second line instead of ending after it. */}
          <p className="line-clamp-2 max-h-8 overflow-hidden text-[0.68rem] leading-4 text-sdc-red-text">
            {s.failure
              ? `${s.failure.replace(/^Failed:\s*/, "")} — still showing the last good data`
              : `No refresh for ${formatSpan(s.overdueBy!)} — the hourly pass has not touched this source`}
          </p>
        </div>
      )}
      {!open && s.state === "waiting" && s.waiting && (
        <div className="px-2.5 pb-1.5">
          <p className="line-clamp-2 max-h-8 overflow-hidden text-[0.68rem] leading-4 text-sdc-yellow-text">{s.waiting}</p>
        </div>
      )}

      {open && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-sdc-border/70 px-2.5 py-2 text-[0.68rem]">
          <Detail term="Status" value={`${ui.label}${s.failStreak > 1 ? ` — ${s.failStreak} passes in a row` : ""}`} />
          <Detail term="Last checked" value={s.checkedAt ? `${formatClock(s.checkedAt)} (${timeAgo(s.checkedAt)})` : "never"} />
          <Detail term="Last success" value={s.lastSuccessAt ? `${formatClock(s.lastSuccessAt)} (${timeAgo(s.lastSuccessAt)})` : "not in recent history"} />
          {s.lastFailureAt && <Detail term="Last failure" value={`${formatClock(s.lastFailureAt)} (${timeAgo(s.lastFailureAt)})`} />}
          {s.refreshedThrough && <Detail term="Data through" value={s.refreshedThrough.toISOString().slice(0, 10)} />}
          {duration && <Detail term="Last duration" value={duration} />}
          {s.detail && <Detail term="Last result" value={s.detail} />}
          {s.failure && <Detail term="Error" value={s.failure.replace(/^Failed:\s*/, "")} tone="bad" />}
          {/* WHAT KIND of failure, and whether waiting can fix it (2026-09-09).
              A panel that says only "failed" invites the one response that cannot
              work — press Refresh again — which is exactly what happened for five
              days while the cause was a parameter-binding bug in this app rather
              than anything wrong with Total ETO. */}
          {s.failureKind && (
            <Detail
              term="Cause"
              value={
                `${s.failureKind.replace(/_/g, " ")}` +
                (s.failureRetryable === false
                  ? " — retrying cannot fix this; it needs a credential, a deploy or a schema change"
                  : s.failureRetryable === true
                    ? " — transient; the next pass has a real chance"
                    : "")
              }
              tone="bad"
            />
          )}
          {s.waiting && <Detail term="Waiting on" value={s.waiting} tone="warn" />}
          <Detail term="Source system" value={s.family} />
          <Detail
            term="Scope"
            value={s.monthScoped ? "Latest open ETC month only — a submitted month is frozen and never touched" : "All months / cumulative"}
          />
          <Detail
            term="Next scheduled"
            value={s.nextRefreshAt ? `${formatClock(s.nextRefreshAt)} — the interval is also the retry` : "on the next pass"}
          />
        </dl>
      )}
    </div>
  );
}

function Detail({ term, value, tone }: { term: string; value: string; tone?: "bad" | "warn" }) {
  return (
    <>
      <dt className="whitespace-nowrap font-medium text-sdc-muted">{term}</dt>
      <dd className={`min-w-0 break-words ${tone === "bad" ? "text-sdc-red-text" : tone === "warn" ? "text-sdc-yellow-text" : "text-sdc-gray-600"}`}>
        {value}
      </dd>
    </>
  );
}

function Group({ title, count, sources, dense = false }: { title: string; count: number; sources: SourceHealth[]; dense?: boolean }) {
  if (sources.length === 0) return null;
  return (
    <div>
      <h4 className="mb-1 text-[0.62rem] font-semibold uppercase tracking-wide text-sdc-muted">
        {title} <span className="tabular-nums">({count})</span>
      </h4>
      <div className="grid items-start gap-1 lg:grid-cols-2">
        {sources.map((s) => (
          <SourceRow key={s.source} s={s} dense={dense} />
        ))}
      </div>
    </div>
  );
}

export function RefreshScheduleCard({ health }: { health: SourceHealthReport }) {
  const { summary, sources, lastRun, running } = health;
  const failed = sortByUrgency(sources.filter((s) => s.state === "failed"));
  const attention = sortByUrgency(sources.filter((s) => s.state === "stale" || s.state === "never"));
  const waiting = sources.filter((s) => s.state === "waiting" || s.state === "refreshing");
  const healthy = sources.filter((s) => s.state === "healthy");
  const anyProblem = failed.length + attention.length > 0;
  // Healthy sources collapse only when there is something worse on screen. With
  // nothing wrong they stay visible — "everything is fine" is worth being able
  // to check, and a panel that hides its own evidence is not reassuring.
  const [showHealthy, setShowHealthy] = useState(false);
  const healthyOpen = !anyProblem || showHealthy;

  const hours = health.intervalMs / 3_600_000;

  const verdictTone =
    summary.tone === "bad"
      ? "border-sdc-red-border bg-sdc-red-bg text-sdc-red-text"
      : summary.tone === "warn"
        ? "border-sdc-yellow/70 bg-sdc-yellow-bg text-sdc-yellow-text"
        : summary.tone === "busy"
          ? "border-sdc-blue-100 bg-sdc-blue-light text-sdc-blue-dark"
          : "border-sdc-green/40 bg-sdc-green-bg text-sdc-green-text";

  return (
    <div className="rounded-xl border border-sdc-border bg-sdc-gray-50/70 p-4">
      {/* ── Verdict + the run metadata the old card carried ─────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-sdc-gray-600">Data source health</h3>
          <div className={`mt-1 inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-semibold ${verdictTone}`}>
            <span aria-hidden>{summary.tone === "bad" ? "✕" : summary.tone === "warn" ? "!" : summary.tone === "busy" ? "↻" : "✓"}</span>
            {summary.headline}
            {summary.troubledFamilies.length > 0 && <span className="font-medium"> · {summary.troubledFamilies.join(", ")}</span>}
          </div>
        </div>
        <p className="shrink-0 text-label text-sdc-muted">
          {running ? (
            <>Refreshing now{running.stage ? ` — ${running.stage}` : ""}</>
          ) : lastRun ? (
            <>
              Last refresh: {lastRun.completedAt ? timeAgo(lastRun.completedAt) : "still running"}
              {lastRun.userName ? ` — started by ${lastRun.userName}` : " — scheduled"}
              {lastRun.completedAt && ` · ${lastRun.sourcesOk}/${lastRun.sourcesOk + lastRun.sourcesFailed} sources ok`}
              {lastRun.sourcesFailed > 0 && <span className="font-semibold text-sdc-red-text"> · {lastRun.sourcesFailed} failed</span>}
              {lastRun.durationMs != null && ` · took ${formatDuration(lastRun.durationMs)}`}
            </>
          ) : (
            "No refresh has been recorded yet"
          )}
        </p>
      </div>

      {/* ── Summary strip: the whole system in seven numbers ────────────────── */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Metric value={String(summary.total)} label="Sources" />
        <Metric value={String(summary.healthy)} label="Healthy" tone={summary.healthy === summary.total ? "good" : "plain"} />
        <Metric value={String(summary.failed)} label="Failed" tone={summary.failed > 0 ? "bad" : "plain"} />
        <Metric value={String(summary.stale + summary.never)} label="Stale" tone={summary.stale + summary.never > 0 ? "warn" : "plain"} />
        <Metric
          value={String(summary.waiting + summary.refreshing)}
          label={summary.refreshing > 0 ? "In progress" : "Waiting"}
          tone={summary.refreshing > 0 ? "busy" : summary.waiting > 0 ? "warn" : "plain"}
        />
        <Metric
          value={lastRun?.completedAt ? timeAgo(lastRun.completedAt) : running ? "running" : "—"}
          label="Last refresh"
          tone={summary.tone === "busy" ? "busy" : "plain"}
        />
        <Metric value={formatDuration(lastRun?.durationMs ?? null) ?? "—"} label="Duration" />
      </div>

      {/* ── Sources, worst first ────────────────────────────────────────────── */}
      <div className="mt-3 flex flex-col gap-2.5">
        <Group title="Failed — action needed" count={failed.length} sources={failed} />
        <Group title="Stale — refresh overdue" count={attention.length} sources={attention} />
        <Group title="Waiting on upstream / in progress" count={waiting.length} sources={waiting} />

        {healthy.length > 0 && (
          <div>
            {anyProblem ? (
              <button
                type="button"
                onClick={() => setShowHealthy((v) => !v)}
                aria-expanded={healthyOpen}
                className="motion-interactive mb-1 flex items-center gap-1.5 text-[0.62rem] font-semibold uppercase tracking-wide text-sdc-muted hover:text-sdc-navy"
              >
                <span aria-hidden className={`h-2 w-2 rounded-full bg-sdc-green`} />
                Healthy <span className="tabular-nums">({healthy.length})</span>
                <span aria-hidden>{healthyOpen ? "▾" : "▸"}</span>
              </button>
            ) : (
              <h4 className="mb-1 text-[0.62rem] font-semibold uppercase tracking-wide text-sdc-muted">
                Healthy <span className="tabular-nums">({healthy.length})</span>
              </h4>
            )}
            {healthyOpen && (
              <div className="grid items-start gap-1 xl:grid-cols-2 2xl:grid-cols-3">
                {healthy.map((s) => (
                  <SourceRow key={s.source} s={s} dense />
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Kept verbatim from the old card: the schedule's own rules, which are the
          reason half these figures mean what they mean. */}
      <p className="mt-3 border-t border-sdc-border/70 pt-2 text-label leading-relaxed text-sdc-gray-400">
        All of these refresh together every {hours === 1 ? "hour" : `${hours} hours`}, in one pass — and “Refresh Data” in the sidebar runs
        that identical pass on demand. There is no separate retry: the interval is the retry. Historical months and app-owned figures
        (quoted hours, New ETC, notes) are deliberately excluded — they are never overwritten by a refresh.
      </p>
    </div>
  );
}
