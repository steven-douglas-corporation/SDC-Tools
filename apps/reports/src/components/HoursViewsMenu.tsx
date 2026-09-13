"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import { type SharedView, publishHoursView, deleteSharedHoursView, renameSharedHoursView } from "@/lib/hours-saved-views-actions";
import {
  HOURS_MY_VIEWS_KEY,
  HOURS_DEFAULT_VIEW_KEY,
  parseMyViews,
  parseDefaultPointer,
  snapshotFromSearch,
  hrefForView,
  renameMyView,
  deleteMyView,
  fixupDefaultPointer,
  type MyViews,
  type DefaultPointer,
} from "@/lib/hours-saved-views";

// "Views ▾" for the Hours tab — a filter/group-by/sort combination, saved and reused.
// Structurally mirrors ProjectViewsMenu.tsx (My views in localStorage, Shared in the
// DB, ★ promotes a mine view to Shared) MINUS its Team Default block: Hours only has a
// PERSONAL default (see hours-saved-views-actions.ts's header for why that's a
// localStorage pointer rather than a server-side concept), never a team-wide one. Two
// things Projects' views don't have at all: Rename (⚑/✎ below), and that personal
// default (⚑ toggle on "mine" rows only — a Shared view can't be defaulted to, since
// that would need a second pointer shape to survive someone else renaming it in a
// browser this one has no access to; a user can already get the same effect by saving
// their own copy of a shared view's current params).

export function HoursViewsMenu({ sharedViews }: { sharedViews: SharedView[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [mine, setMine] = useState<MyViews>({});
  const [defaultPtr, setDefaultPtr] = useState<DefaultPointer | null>(null);
  const [busy, setBusy] = useState(false);
  const activeName = searchParams.get("view");

  useEffect(() => {
    const myViews = parseMyViews(window.localStorage.getItem(HOURS_MY_VIEWS_KEY));
    const ptr = parseDefaultPointer(window.localStorage.getItem(HOURS_DEFAULT_VIEW_KEY));
    // localStorage isn't readable during render (no window on the server, and it must
    // not vary the first client render from the server-rendered markup), so hydrating
    // it into state has to happen in an effect — the same pre-existing pattern (and
    // pre-existing react-hooks/set-state-in-effect finding) as ProjectViewsMenu.tsx's
    // own `useEffect(() => setMine(readMyViews()), [])`. Not fixed here as a byproduct
    // of this feature — a real fix (useSyncExternalStore) is a broader change than one
    // toolbar menu's mount hydration warrants.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMine(myViews);
    setDefaultPtr(ptr);
    // Auto-apply the personal default — but ONLY on a bare visit (no params at all).
    // Any param, even a stray `?page=2`, means the user arrived via an explicit
    // bookmark/shared link, which must never be silently overridden.
    if (window.location.search === "" && ptr && myViews[ptr.name]) {
      router.replace(hrefForView(myViews[ptr.name], ptr.name));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) detailsRef.current.open = false;
    }
    // Escape closes, matching the other three toolbar menus (see
    // useDraftParamMenu). This one does not share that hook — it has no draft to
    // apply, only actions — so it needs its own handler.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || !detailsRef.current?.open) return;
      detailsRef.current.open = false;
      detailsRef.current.querySelector("summary")?.focus();
    }
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  function writeMine(next: MyViews) {
    window.localStorage.setItem(HOURS_MY_VIEWS_KEY, JSON.stringify(next));
    setMine(next);
  }

  function writeDefaultPtr(next: DefaultPointer | null) {
    if (next) window.localStorage.setItem(HOURS_DEFAULT_VIEW_KEY, JSON.stringify(next));
    else window.localStorage.removeItem(HOURS_DEFAULT_VIEW_KEY);
    setDefaultPtr(next);
  }

  function handleSaveMine() {
    const name = window.prompt(
      "Name this view — it saves the current filters, group-by fields and sort. It stays private to you until you ★ share it.",
    );
    if (!name || !name.trim()) return;
    const clean = name.trim();
    writeMine({ ...mine, [clean]: snapshotFromSearch(window.location.search) });
    toast(`Saved view "${clean}"`);
    close();
  }

  function handleDeleteMine(name: string) {
    writeMine(deleteMyView(mine, name));
    writeDefaultPtr(fixupDefaultPointer(defaultPtr, { kind: "delete", name }));
  }

  function handleRenameMine(name: string) {
    const newName = window.prompt("Rename this view", name);
    if (newName === null) return;
    const result = renameMyView(mine, name, newName);
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    writeMine(result.views);
    writeDefaultPtr(fixupDefaultPointer(defaultPtr, { kind: "rename", from: name, to: result.name }));
  }

  function toggleDefault(name: string) {
    const isCurrentDefault = defaultPtr?.tier === "mine" && defaultPtr.name === name;
    writeDefaultPtr(isCurrentDefault ? null : { tier: "mine", name });
  }

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : label, "error");
    } finally {
      setBusy(false);
    }
  }

  function handlePublish(name: string, config: MyViews[string]) {
    void run("Couldn't share this view.", async () => {
      await publishHoursView(name, config);
      // Moves out of My views (it now lives in Shared), same idiom Projects uses —
      // and a "mine" view being removed needs the same default-pointer fixup a
      // delete would, since the default can never point at a Shared view.
      writeMine(deleteMyView(mine, name));
      writeDefaultPtr(fixupDefaultPointer(defaultPtr, { kind: "delete", name }));
      toast(`Shared "${name}" with the team`);
    });
  }

  function handleRenameShared(view: SharedView) {
    const newName = window.prompt("Rename this shared view (affects everyone)", view.name);
    if (newName === null || !newName.trim() || newName.trim() === view.name) return;
    void run("Couldn't rename this view.", () => renameSharedHoursView(view.id, view.name, newName));
  }

  const sec = (label: string) => <div className="px-3 pt-2 pb-1 text-label font-semibold uppercase tracking-wider text-sdc-gray-400">{label}</div>;
  const rowBtn = "flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-sdc-gray-100";
  const iconBtn = "shrink-0 rounded px-1.5 text-note text-sdc-muted hover:bg-sdc-gray-100 hover:text-sdc-navy";

  const myNames = Object.keys(mine).sort((a, b) => a.localeCompare(b));

  return (
    <details ref={detailsRef} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${activeName ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}>
        {activeName ? `View: ${activeName}` : "Views"}
        <svg
          viewBox="0 0 16 16"
          width="10"
          height="10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="shrink-0 opacity-70 motion-interactive group-open:rotate-180"
        >
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-80 rounded-lg border border-sdc-border bg-white py-1 shadow-lg">
        {sharedViews.length > 0 && sec("Shared")}
        {sharedViews.map((v) => (
          <div key={v.name} className="flex items-center gap-1 px-2 py-0.5">
            <button type="button" onClick={() => router.push(hrefForView(v.config, v.name))} className={rowBtn}>
              {v.name}
              {v.owner ? <span className="text-label text-sdc-gray-400"> · {v.owner}</span> : null}
            </button>
            <button type="button" title="Rename this shared view (affects everyone)" disabled={busy} className={iconBtn} onClick={() => handleRenameShared(v)}>
              ✎
            </button>
            <button
              type="button"
              title="Delete this shared view (affects everyone)"
              disabled={busy}
              className={iconBtn}
              onClick={() => {
                if (window.confirm(`Delete shared view "${v.name}"? This removes it for everyone.`)) {
                  void run("Couldn't delete the view.", () => deleteSharedHoursView(v.name));
                }
              }}
            >
              ✕
            </button>
          </div>
        ))}

        {sec("My views")}
        {myNames.length ? (
          myNames.map((name) => {
            const isDefault = defaultPtr?.tier === "mine" && defaultPtr.name === name;
            return (
              <div key={name} className="flex items-center gap-1 px-2 py-0.5">
                <button
                  type="button"
                  title={isDefault ? "Your default view — click to unset" : "Set as your default view"}
                  onClick={() => toggleDefault(name)}
                  className={`${iconBtn} ${isDefault ? "text-sdc-blue" : ""}`}
                >
                  {isDefault ? "⚑" : "⚐"}
                </button>
                <button type="button" onClick={() => router.push(hrefForView(mine[name], name))} className={rowBtn}>
                  {name}
                </button>
                <button type="button" title="Rename this view" className={iconBtn} onClick={() => handleRenameMine(name)}>
                  ✎
                </button>
                <button type="button" title="Share this view with everyone" className={iconBtn} disabled={busy} onClick={() => handlePublish(name, mine[name])}>
                  ★
                </button>
                <button type="button" title="Delete this view" className={iconBtn} onClick={() => handleDeleteMine(name)}>
                  ✕
                </button>
              </div>
            );
          })
        ) : (
          <div className="px-3 pb-1 text-xs text-sdc-gray-400">None yet.</div>
        )}

        <div className="my-1 border-t border-sdc-border-soft" />
        <button type="button" onClick={handleSaveMine} className="block w-full px-3 py-1.5 text-left text-xs font-semibold text-sdc-navy hover:bg-sdc-gray-100">
          + Save current as view…
        </button>
      </div>
    </details>
  );
}
