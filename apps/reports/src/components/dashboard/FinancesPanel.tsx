import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { Band, Panel, PanelHead } from "@/components/dashboard/DashboardLayout";
import { monthLabel } from "@/components/dashboard/DashboardOverview";
import { usd } from "@/components/ui/format";
import type { FinanceCardDef } from "@/lib/finance-cards";
import { loadPartsSpent, loadTmDollars } from "@/lib/dashboard-finances";
import { DashboardFeedbackBand } from "@/components/dashboard/DashboardFeedbackBand";
import { PartsBudgetAnalysis } from "@/components/dashboard/PartsBudgetAnalysis";
import { PARTS_BUDGET_SECTION } from "@/lib/finance-cards";
import { loadPartsBudgetAnalysis } from "@/lib/parts-budget-analysis";

// ── The Finances tab (2026-10-20) ───────────────────────────────────────────
//
// Every card is a window onto a page that already shows the figure, and ends in a
// "More details" link to it — see lib/finance-cards.ts for the rule and
// lib/dashboard-finances.ts for the readers. This file is only layout.
//
// Each card loads on its own, behind its own Suspense boundary, because they do not
// cost the same: the T&M card reads Total ETO. One slow source holds back its own card
// and nothing else.

function FinanceCard({
  def,
  month,
  note,
  children,
}: {
  def: FinanceCardDef;
  month: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <Panel>
      <PanelHead
        title={def.title}
        note={note}
        action={
          <Link href={def.href(month)} className="text-xs font-semibold text-sdc-blue hover:underline">
            More details <span aria-hidden>→</span>
          </Link>
        }
      />
      <div className="mt-2">{children}</div>
      <p className="mt-3 text-label text-sdc-gray-400">From {def.source}</p>
    </Panel>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="font-heading text-xl font-bold tabular-nums text-sdc-navy">{value}</p>
      <p className="mt-0.5 text-label font-bold uppercase tracking-wide text-sdc-muted">{label}</p>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm text-sdc-muted">{children}</p>;
}

function CardSkeleton({ def, month }: { def: FinanceCardDef; month: string }) {
  return (
    <FinanceCard def={def} month={month}>
      <p role="status" className="py-2 text-sm text-sdc-muted">
        Loading…
      </p>
    </FinanceCard>
  );
}

async function PartsSpentCard({ def, month }: { def: FinanceCardDef; month: string }) {
  const r = await loadPartsSpent(month);
  return (
    <FinanceCard def={def} month={month} note={monthLabel(month)}>
      {r.state === "ok" ? (
        <Figure label={`Across ${r.jobs} ${r.jobs === 1 ? "job" : "jobs"}`} value={usd(r.spent)} />
      ) : r.state === "notStarted" ? (
        <Quiet>The Monthly ETC for {monthLabel(month)} has no Parts Cost rows yet.</Quiet>
      ) : (
        <Quiet>Couldn&apos;t load this right now. Open Monthly ETC for the figure.</Quiet>
      )}
    </FinanceCard>
  );
}

async function TmCard({ def, month }: { def: FinanceCardDef; month: string }) {
  const r = await loadTmDollars(month);
  return (
    <FinanceCard def={def} month={month} note={`Invoiced in ${monthLabel(month)}, all jobs`}>
      {r.state === "ok" ? (
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Figure label="Part invoiced" value={usd(r.partInvoiced)} />
          <Figure label="SDC manufactured parts" value={usd(r.sdcManufactured)} />
          <Figure label="Expense reports" value={usd(r.expenseReports)} />
        </div>
      ) : (
        <Quiet>Couldn&apos;t reach Total ETO right now. Open T&amp;M for the figures.</Quiet>
      )}
    </FinanceCard>
  );
}

const CARD_BY_KEY: Record<FinanceCardDef["key"], (p: { def: FinanceCardDef; month: string }) => Promise<React.JSX.Element>> = {
  "parts-spent": PartsSpentCard,
  tm: TmCard,
};

// Loads on its own behind its own Suspense boundary: it reads Total ETO for every job, so a slow read
// holds back this section and nothing else.
async function PartsBudgetSection() {
  const r = await loadPartsBudgetAnalysis();
  if (r.state !== "ok") {
    return (
      <Panel>
        <Quiet>
          Couldn&apos;t load the projection figures right now. Open Job Details for a single job&apos;s Parts Cost, or try again
          in a moment.
        </Quiet>
      </Panel>
    );
  }
  if (r.rows.length === 0) {
    return (
      <Panel>
        <Quiet>No job has parts cost to report yet.</Quiet>
      </Panel>
    );
  }
  return <PartsBudgetAnalysis rows={r.rows} notStarted={r.notStarted} asOf={r.asOf} />;
}

export function FinancesPanel({
  month,
  cards,
  partsBudget = false,
}: {
  month: string;
  cards: FinanceCardDef[];
  /** The role may open Job Details, so the Parts cost vs budget section is offered. */
  partsBudget?: boolean;
}) {
  return (
    <div className="flex flex-col gap-8">
      <Band label="This month">
        <div className="grid gap-4 lg:grid-cols-2">
          {cards.map((def) => {
            const Card = CARD_BY_KEY[def.key];
            return (
              <Suspense key={def.key} fallback={<CardSkeleton def={def} month={month} />}>
                <Card def={def} month={month} />
              </Suspense>
            );
          })}
        </div>
      </Band>

      {partsBudget && (
        <Band label={PARTS_BUDGET_SECTION.title}>
          <Suspense
            fallback={
              <Panel>
                <p role="status" className="py-2 text-sm text-sdc-muted">
                  Loading every job&apos;s projection…
                </p>
              </Panel>
            }
          >
            <PartsBudgetSection />
          </Suspense>
        </Band>
      )}

      {/* The tab is a prototype and nobody yet knows everything it should hold — this is
          how the people who use it say. See DashboardFeedbackBand. */}
      <DashboardFeedbackBand view="finances" month={month} />
    </div>
  );
}
