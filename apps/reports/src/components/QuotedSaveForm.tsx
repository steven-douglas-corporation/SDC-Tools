"use client";

import { createContext, useActionState, useContext, useEffect, useRef } from "react";
import { BASELINE_ATTR, changedFormData, countChanged } from "@/lib/dirty-form";
import { requestLiveRefresh } from "@/components/LiveRefresh";
import type { SaveQuotedResult } from "@/lib/quoted-actions";

// The Projects grid's <form>. Two jobs, both of which need a client component:
//
// 1. It holds useActionState, so the Save button can report what the action
//    actually did — counts on success, the message on failure. A server
//    component's `<form action={serverAction}>` can never see the return value,
//    which is why a validation error used to have to reach the user by throwing
//    into the route's error boundary, discarding the grid and every unsaved edit
//    in it.
// 2. It submits ONLY the controls whose value differs from the server's — see
//    dirty-form.ts. A native submit posts the entire matrix (~1,100 fields for 50
//    jobs × 13 sections) on every save, however little was edited.
//
// The grid itself stays a SERVER component, passed through as `children`, so none
// of those thousands of cells ship to the browser as client JS. This file renders
// a <form> and nothing else.
//
// Note the trade this makes: submission now runs through onSubmit rather than the
// form's `action`, so saving requires JavaScript. That's not a new dependency in
// practice — the grid's cell editing, menus and toolbar are all client components
// already — but it is the reason `action` is deliberately absent below.

type SaveCtxValue = { result: SaveQuotedResult | null; pending: boolean };

// Defaults let the Save button render in isolation (tests, stories) without a
// provider rather than crashing.
const SaveCtx = createContext<SaveCtxValue>({ result: null, pending: false });

export function useSaveState(): SaveCtxValue {
  return useContext(SaveCtx);
}

export function QuotedSaveForm({
  action,
  className,
  children,
}: {
  action: (prev: SaveQuotedResult | null, formData: FormData) => Promise<SaveQuotedResult>;
  className?: string;
  children: React.ReactNode;
}) {
  const [result, dispatch, pending] = useActionState(action, null);
  const formRef = useRef<HTMLFormElement>(null);
  // What the in-flight save is writing: field name -> the value we sent. Held so
  // that on success the controls can be re-baselined here, instead of waiting for
  // the server to re-render the grid just to restate the same numbers.
  const inFlightValues = useRef<Map<string, string> | null>(null);

  // ── Re-baseline on success, so a save costs no page render ──────────────────
  //
  // dirty-form.ts decides "changed" by comparing a control's value to its
  // server-rendered `data-baseline`. Until 2026-08-03 the only thing that
  // refreshed those attributes was revalidatePath re-rendering the whole route
  // after every save — which is what made saving slow (the writes are ~10ms).
  //
  // The client already knows what it just persisted, so it can stamp the new
  // baseline itself. The field then reads clean, autosave stops re-sending it, and
  // nothing re-renders.
  //
  // Guarded on the value being UNCHANGED since we sent it: if the user kept typing
  // during the save, that newer value is genuinely unsaved, and stamping our older
  // one as the baseline would mark it clean and lose the edit. Leaving it dirty is
  // what makes useAutosave's follow-up pass pick it up.
  useEffect(() => {
    const sent = inFlightValues.current;
    if (pending || !sent) return;
    inFlightValues.current = null;
    if (!result?.ok) return; // a rejected save changed nothing; keep the fields dirty
    const form = formRef.current;
    if (!form) return;
    // A created row has no id-bearing control here yet — the server re-render
    // (still triggered for that case) is what replaces the temp row, so leave
    // those alone entirely.
    if (result.created > 0) return;
    // Cells the server REFUSED because another user had already changed them
    // (2026-08-04). Re-baselining one would be a lie in the worst place: the cell
    // would stop reading as dirty, the chip would say saved, and a value the server
    // rejected would sit on screen looking persisted. Left dirty on purpose.
    const refused = new Set(result.conflictFields);
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
      if (!el.name) continue;
      if (refused.has(el.name)) continue;
      const value = sent.get(el.name);
      if (value === undefined) continue;
      if (el.value !== value) continue; // edited again mid-flight — still dirty, correctly
      el.setAttribute(BASELINE_ATTR, value);
    }
    // Pull the real figures in so the manager is reconciling against what is
    // actually stored rather than retyping over a colleague a second time.
    if (result.conflicts > 0) requestLiveRefresh();
  }, [pending, result]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    // Owning the submit outright: React would otherwise serialize the whole form
    // for us, which is precisely the cost being avoided.
    e.preventDefault();
    if (pending) return; // ignore a double-click on Save mid-flight
    const form = formRef.current;
    if (!form) return;
    // Deliberately still dispatched when nothing changed: the action reports "No
    // changes to save", which is real information — silently doing nothing is
    // indistinguishable from a broken button, which is how this page's save came
    // to be doubted in the first place.
    const changed = countChanged(form);
    console.debug(`[Projects] saving ${changed} changed field${changed === 1 ? "" : "s"} of ${form.elements.length}`);
    const fd = changedFormData(form);
    // Remember what is being written, for the re-baselining effect above. Built
    // from the FormData actually dispatched rather than re-read off the DOM, so
    // the two can't disagree.
    const sent = new Map<string, string>();
    for (const [name, value] of fd.entries()) if (typeof value === "string") sent.set(name, value);
    inFlightValues.current = sent;
    dispatch(fd);
  }

  return (
    <SaveCtx.Provider value={{ result, pending }}>
      <form ref={formRef} onSubmit={onSubmit} className={className}>
        {children}
      </form>
    </SaveCtx.Provider>
  );
}
