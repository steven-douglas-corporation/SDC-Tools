"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

// ── The one generic drawer shell for every Build Readiness drilldown ────────
//
// Copies PoPanel's exact chrome (src/components/procurement/PoDetailPanel.tsx
// — fixed inset-0 + backdrop click-to-close + a right-aligned `aside` sliding
// panel + Escape-to-close + the mount-then-rAF open / 200ms-delayed close
// animation) so the whole page reads as ONE drawer language, even though this
// is a separate component from PoPanel: PoPanel's header (supplier avatar +
// stat row + progress bars) is domain-specific to a PO and stays exactly as
// it is — when a drill stack's top frame is a PO, the caller renders the real
// `<PoPanel>` directly instead of this shell. This shell is for every OTHER
// drill (assemblies, parts, blockers, suppliers, forecast weeks, ...), each
// of which needs a title + optional badge + breadcrumb, not PoPanel's
// specific header layout.
export type DrawerBadge = { label: string; cls: string };

export function BuildReadinessDrawer({
  title,
  subtitle,
  badge,
  breadcrumb,
  onBreadcrumbClick,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  badge?: DrawerBadge;
  // One label per stacked frame, root first. A single-entry breadcrumb (the
  // very first drill) renders no strip at all — nothing to navigate back to
  // yet.
  breadcrumb: string[];
  onBreadcrumbClick: (index: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setOpen(true));
    return () => window.cancelAnimationFrame(id);
  }, []);

  const requestClose = useCallback(() => {
    setOpen(false);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      {/* Backdrop */}
      <div
        onClick={requestClose}
        className={`absolute inset-0 bg-sdc-navy/40 motion-interactive ${open ? "opacity-100" : "opacity-0"}`}
      />
      {/* Panel — same 800px / 92vw-capped width as PoPanel, for one consistent
          drawer size across every Build Readiness drilldown. */}
      <aside
        className={`absolute right-0 top-0 flex h-full w-[800px] max-w-[calc(var(--app-vw)_*_0.92)] flex-col bg-white shadow-xl motion-interactive ${open ? "translate-x-0" : "translate-x-full"}`}
      >
        <div className="flex flex-col gap-2 border-b border-sdc-border-soft p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-base font-bold text-sdc-navy" title={title}>{title}</div>
              {subtitle && <div className="truncate text-xs text-sdc-gray-600" title={subtitle}>{subtitle}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {badge && <span className={`shrink-0 rounded px-1.5 py-0.5 text-micro font-bold tracking-wide ${badge.cls}`}>{badge.label}</span>}
              <button type="button" onClick={requestClose} aria-label="Close" className="rounded p-1 text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4 L12 12 M12 4 L4 12" strokeLinecap="round" /></svg>
              </button>
            </div>
          </div>

          {/* Breadcrumb — the drill chain so far. Every segment but the last
              is a real button (click to jump back to that level); the last
              segment is the current title, in bold, non-interactive. */}
          {breadcrumb.length > 1 && (
            <div className="flex flex-wrap items-center gap-1 text-note">
              {breadcrumb.map((label, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <span className="text-sdc-gray-300" aria-hidden>/</span>}
                  {i === breadcrumb.length - 1 ? (
                    <span className="font-semibold text-sdc-navy">{label}</span>
                  ) : (
                    <button type="button" onClick={() => onBreadcrumbClick(i)} className="text-sdc-blue hover:underline">
                      {label}
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto styled-scrollbar">{children}</div>
      </aside>
    </div>
  );
}
