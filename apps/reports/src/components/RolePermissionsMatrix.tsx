"use client";

import { Fragment, useState, useTransition } from "react";
import { PERMISSION_CATALOG, PERMISSION_SECTIONS, type PermissionCatalogEntry } from "@/lib/permission-catalog";
import { setRolePermissionAction } from "@/lib/role-permissions-actions";
import type { RolePermissionMatrixRow } from "@/lib/role-permissions-store";
import { EDITABLE_ROLES, ROLE_LABELS, type EditableRole } from "@/lib/permissions";

// Columns come from EDITABLE_ROLES / ROLE_LABELS rather than a second literal
// list kept in step by hand — adding PM (2026-09-01) was a one-line change in
// lib/permissions.ts precisely because this reads from there. The ELT column is
// rendered separately below: it is always on and never stored.
const ROLE_COLUMNS: { role: EditableRole; label: string }[] = EDITABLE_ROLES.map((role) => ({
  role,
  label: ROLE_LABELS[role],
}));

// Permission column + one per editable role + ELT.
const TOTAL_COLUMNS = ROLE_COLUMNS.length + 2;

function cellId(role: EditableRole, entry: PermissionCatalogEntry): string {
  return `${role}:${entry.keys.join(",")}`;
}

function emptyEnabled(): Record<EditableRole, boolean> {
  return Object.fromEntries(EDITABLE_ROLES.map((r) => [r, false])) as Record<EditableRole, boolean>;
}

// The live, ELT-editable permission matrix.
//
// ── Every checkbox is independent (2026-09-01) ──────────────────────────────
//
// This component used to re-derive a CASCADE after each successful save:
// ticking a lower tier visibly ticked every tier above it, because the server
// did the same thing. Both halves are gone. A click now writes exactly one
// (role, permission) row and updates exactly that one box, so ticking
// Managers → Monthly ETC leaves Sales, PM and All untouched — and unticking
// Sales leaves Managers alone.
//
// Each checkbox still writes through setRolePermissionAction (a real Server
// Action — permissions:manage is re-checked there independently) and the save
// is broadcast to every connected session (see RealtimeProvider.tsx). The local
// state update below is only so this tab's own click feels instant rather than
// waiting on the SSE round trip back to itself.
export function RolePermissionsMatrix({ initialRows }: { initialRows: RolePermissionMatrixRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [pendingCells, setPendingCells] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const byKey = new Map(rows.map((r) => [r.permission, r]));

  function isChecked(entry: PermissionCatalogEntry, role: EditableRole): boolean {
    return entry.keys.every((k) => byKey.get(k)?.enabled[role] ?? false);
  }

  function toggle(entry: PermissionCatalogEntry, role: EditableRole, next: boolean) {
    const id = cellId(role, entry);
    setError(null);
    setPendingCells((prev) => new Set(prev).add(id));
    startTransition(async () => {
      try {
        for (const key of entry.keys) {
          const result = await setRolePermissionAction(role, key, next);
          if (!result.ok) {
            setError(result.error);
            return;
          }
        }
        // ONLY the clicked role's own cell moves. A multi-key row (Standard
        // Fees) moves all of ITS keys for THIS role, which is what makes the
        // one visible checkbox honest — it is still one role's column.
        setRows((prev) => {
          const byKeyNext = new Map(prev.map((r) => [r.permission, { ...r, enabled: { ...r.enabled } }]));
          for (const key of entry.keys) {
            const row = byKeyNext.get(key) ?? { permission: key, enabled: emptyEnabled() };
            row.enabled[role] = next;
            byKeyNext.set(key, row);
          }
          return [...byKeyNext.values()];
        });
      } finally {
        setPendingCells((prev) => {
          const next2 = new Set(prev);
          next2.delete(id);
          return next2;
        });
      }
    });
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-sdc-border bg-white shadow-sm">
      <table className="w-full min-w-[720px] border-collapse text-sm">
        <thead className="sticky top-0 z-10 bg-sdc-navy text-label font-bold uppercase tracking-wide text-white">
          <tr>
            <th className="px-4 py-2.5 text-left">Permission</th>
            {ROLE_COLUMNS.map(({ role, label }) => (
              <th key={role} className="px-3 py-2.5 text-center">
                {label}
              </th>
            ))}
            <th className="px-3 py-2.5 text-center">ELT</th>
          </tr>
        </thead>
        <tbody>
          {PERMISSION_SECTIONS.map((section) => {
            const entries = PERMISSION_CATALOG.filter((e) => e.section === section);
            if (entries.length === 0) return null;
            return (
              <Fragment key={section}>
                <tr className="bg-sdc-gray-50">
                  <td colSpan={TOTAL_COLUMNS} className="px-4 py-1.5 text-label font-bold uppercase tracking-wide text-sdc-muted">
                    {section}
                  </td>
                </tr>
                {entries.map((entry) => (
                  <tr key={entry.keys.join(",")} className="border-t border-sdc-border/60">
                    <td className={`px-4 py-2 ${entry.indent ? "pl-8 text-sdc-gray-600" : "font-medium text-sdc-navy"}`}>{entry.label}</td>
                    {ROLE_COLUMNS.map(({ role, label }) => (
                      <td key={role} className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={isChecked(entry, role)}
                          disabled={pendingCells.has(cellId(role, entry))}
                          onChange={(e) => toggle(entry, role, e.target.checked)}
                          aria-label={`${entry.label} for ${label}`}
                          className="h-4 w-4 accent-sdc-blue disabled:opacity-50"
                        />
                      </td>
                    ))}
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked
                        disabled
                        title="ELT always has full access — this can't be turned off here."
                        className="h-4 w-4 accent-sdc-blue opacity-60"
                      />
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
          <tr className="border-t border-sdc-border/60 bg-sdc-gray-50/60">
            <td className="px-4 py-2 italic text-sdc-muted" colSpan={TOTAL_COLUMNS - 1}>
              Anything added later that isn&apos;t listed above
            </td>
            <td className="px-3 py-2 text-center">
              <input
                type="checkbox"
                checked
                disabled
                title="Any future permission not yet listed here is ELT-only, automatically."
                className="h-4 w-4 accent-sdc-blue opacity-60"
              />
            </td>
          </tr>
        </tbody>
      </table>
      {error && <p className="border-t border-sdc-border px-4 py-2 text-sm text-sdc-red-text">{error}</p>}
    </div>
  );
}
