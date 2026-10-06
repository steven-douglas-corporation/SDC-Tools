import { DASH, type EmployeeRow } from "@/lib/employee-row";
import type { CardColors } from "@/lib/employee-card-theme";

// The pieces a department card is made of, shared by the Employees page's two
// views (2026-10-02) so a card looks the same in Cards and in Org chart: the
// coloured header and one person's row. Moved out of EmployeesCards.tsx
// unchanged; the Org chart adds only its nesting lines around the rows.

// Title/discipline, whichever adds information — showing the card's own
// department name again under every row inside it would just repeat the
// header, so a person's discipline is only printed when it says something
// their card doesn't already.
export function roleOf(r: EmployeeRow, cardTitle: string): string {
  if (r.positionTitle !== DASH) return r.positionTitle;
  if (r.discipline !== DASH && r.discipline !== cardTitle) return r.discipline;
  return DASH;
}

export function DepartmentCardHeader({ title, colors, isAi, className = "" }: { title: string; colors: CardColors; isAi?: boolean; className?: string }) {
  return (
    <header className={`px-3.5 py-2.5 ${className}`} style={{ background: colors.bg, color: colors.text }}>
      <h3 className="flex items-center gap-1 truncate text-sm font-bold">
        {title}
        {/* AI department marker (2026-09-22) — a small bot glyph after the
            card name, matching the way the lead star sits beside a person's
            name below, so the card reads as AI-related at a glance. */}
        {isAi && (
          <span className="text-sm" title="AI department" aria-hidden>
            🤖
          </span>
        )}
      </h3>
    </header>
  );
}

// Why someone isn't placed by their own position family — on hover or focus.
// CSS only (group-hover / group-focus), anchored to the row so it stays inside the card.
function Note({ text }: { text: string }) {
  return (
    <span
      tabIndex={0}
      role="note"
      aria-label={text}
      onClick={(e) => e.stopPropagation()}
      className="group/note inline-grid size-[15px] flex-none cursor-help place-items-center rounded-full border border-sdc-yellow-text font-mono text-label font-bold italic leading-none text-sdc-yellow-text focus-visible:outline-2 focus-visible:outline-sdc-blue"
    >
      i
      <span className="pointer-events-none absolute bottom-[calc(100%+2px)] left-0 z-10 w-max max-w-full rounded bg-sdc-navy px-2 py-1 font-sans text-note font-medium not-italic leading-snug text-white opacity-0 shadow-sm motion-interactive group-hover/note:opacity-100 group-focus/note:opacity-100">
        {text}
      </span>
    </span>
  );
}

export function EmployeePersonRow({
  p,
  cardTitle,
  onSelect,
  note,
  hideLeadershipBadge,
}: {
  p: EmployeeRow;
  /** The Executive Leadership card, where everyone is Leadership: the badge says nothing there and crowds the names out. */
  hideLeadershipBadge?: boolean;
  cardTitle: string;
  onSelect?: (row: EmployeeRow) => void;
  /** The Org chart's "placed by reporting line" explanation, if any. */
  note?: string | null;
}) {
  const role = roleOf(p, cardTitle);
  return (
    <div
      title={`${p.name} — ${role === DASH ? "no title/discipline on file" : role}, reports to ${p.supervisor}, ${p.department?.trim() || DASH}`}
      onClick={onSelect ? () => onSelect(p) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(p);
              }
            }
          : undefined
      }
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      className={`relative flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-sdc-blue-light/40 ${onSelect ? "cursor-pointer" : ""} ${p.active ? "" : "opacity-70"}`}
    >
      {p.isLead && (
        <span className="shrink-0 text-sm text-sdc-yellow" title="Department lead" aria-hidden>
          ★
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`min-w-0 truncate text-sm font-medium ${p.isLead || p.isLeadership ? "font-bold" : ""} ${p.active ? "text-sdc-navy" : "text-sdc-muted"}`}>{p.name}</span>
          {note && <Note text={note} />}
        </div>
        {role !== DASH && <div className="truncate text-xs text-sdc-muted">{role}</div>}
      </div>
      {p.isLeadership && !hideLeadershipBadge && (
        <span className="shrink-0 rounded-full bg-sdc-navy px-2 py-0.5 text-label font-semibold uppercase tracking-wide text-white" title="Leadership (position family 100)">
          Leadership
        </span>
      )}
      {p.specialty && (
        <span className="shrink-0 truncate rounded-full border border-sdc-border px-2 py-0.5 text-label text-sdc-muted" title={`Level / specialty: ${p.specialty}`}>
          {p.specialty}
        </span>
      )}
      {!p.active && (
        <span className="shrink-0 rounded-full bg-sdc-gray-100 px-1.5 py-0.5 text-label font-semibold uppercase tracking-wide text-sdc-muted">
          Inactive
        </span>
      )}
    </div>
  );
}

/**
 * The bottom of a card for people not in Paylocity (2026-10-05, by request):
 * temps and hand-entered rows (isPaylocityId false), set apart from the
 * Paylocity roster above on a darker ground. Used by both views.
 */
/**
 * The part of a card for people whose team was set by hand (2026-10-06, by
 * request): below the Paylocity roster and above the contractors, on a third
 * ground (a soft blue) so it reads apart from both. `last` rounds the bottom
 * corners when no contractors section follows.
 */
export function HandPlacedSection({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`border-t border-sdc-border bg-sdc-blue-light/25 ${last ? "rounded-b-[11px]" : ""}`}>
      <p className="px-3.5 pt-2 text-label font-semibold uppercase tracking-wider text-sdc-muted">Team set by hand</p>
      <ul className="p-1.5 pt-0.5">{children}</ul>
    </div>
  );
}

export function TempsSection({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-b-[11px] border-t border-sdc-border bg-sdc-gray-100">
      <p className="px-3.5 pt-2 text-label font-semibold uppercase tracking-wider text-sdc-muted">Contractors · not in Paylocity</p>
      <ul className="p-1.5 pt-0.5">{children}</ul>
    </div>
  );
}
