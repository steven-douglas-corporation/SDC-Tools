"use client";

import { useEffect } from "react";
import { deliveryWeeks, formatWeeks } from "@/lib/delivery-weeks";
import { subscribeRemoteEtcValues } from "@/lib/etc-remote-values";

// Recalculates each row's "Weeks to Delivery" as its Start Date or Quoted Delivery is edited.
//
// The weeks cell is server-rendered (so the 233-row grid stays out of the client bundle, the
// same reasoning as ProjectsLiveTotals) and is a pure function of two inputs in the SAME row.
// So this is one document-level listener that rewrites the text of that row's weeks cell — no
// React state, nothing re-rendered.
//
// The arithmetic is lib/delivery-weeks.ts, the function the server render uses, so what shows
// while typing is exactly what shows after a reload. Nothing is posted: the weeks are derived,
// and only the Quoted Delivery date is stored.
//
// Also re-run when a colleague's save is adopted into a cell (ProjectsRemoteCells writes input
// values directly, which fires no input event).

const WATCHED = /__(startDate|quotedDeliveryDate)$/;

function refreshRow(row: Element | null) {
  if (!row) return;
  const cell = row.querySelector<HTMLElement>("[data-weeks-cell]");
  if (!cell) return;
  const start = row.querySelector<HTMLInputElement>('input[name$="__startDate"]');
  const delivery = row.querySelector<HTMLInputElement>('input[name$="__quotedDeliveryDate"]');
  const text = formatWeeks(deliveryWeeks(start?.value ?? null, delivery?.value ?? null));
  if (cell.textContent !== text) cell.textContent = text;
}

export function ProjectsDeliveryWeeks() {
  useEffect(() => {
    const onEdit = (e: Event) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !WATCHED.test(t.name)) return;
      refreshRow(t.closest("tr"));
    };
    const refreshAll = () => {
      document.querySelectorAll("[data-weeks-cell]").forEach((c) => refreshRow(c.closest("tr")));
    };
    document.addEventListener("input", onEdit);
    document.addEventListener("change", onEdit);
    // Deferred so ProjectsRemoteCells (whose listener adopts the value) has run first.
    const unsubscribe = subscribeRemoteEtcValues(() => queueMicrotask(refreshAll));
    return () => {
      document.removeEventListener("input", onEdit);
      document.removeEventListener("change", onEdit);
      unsubscribe();
    };
  }, []);
  return null;
}
