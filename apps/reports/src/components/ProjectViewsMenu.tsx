"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { TOOLBAR_BTN, TOOLBAR_BTN_ACTIVE, TOOLBAR_BTN_NEUTRAL } from "@/components/ui/classnames";
import {
  type SharedView,
  type ViewConfig,
  publishView,
  deleteSharedView,
  setTeamDefault,
  deleteTeamDefault,
} from "@/lib/saved-views-actions";

// "Views ▾" for the Projects grid — ported from the Scheduler's shared
// column-views. A view snapshots the grid's URL state (which section columns
// show, hidden info columns, sort, and the Customer/Type/Status/Billable
// filters) plus the Actuals toggle. Three tiers:
//   • Team Default — one pinned view for everybody (server-side).
//   • Shared — named views anyone published, with the owner's name (server-side).
//   • My views — private to this browser (localStorage); ★ promotes one to Shared.
//
// It used to snapshot this tab's Grid Size (row height + column width) too. §45
// retired those steppers for one application-wide Zoom, and zoom is deliberately NOT
// part of a view: a view is about which figures you are looking at, and picking one
// should not resize somebody's whole application. Views saved before this still carry
// a `grid` field; it is ignored (see ViewConfig).
const MY_VIEWS_KEY = "quoted-my-views";
// The exact set of /quoted query params a view captures (columns + filters +
// the Actuals toggle, which used to be a localStorage flag restored separately).
const VIEW_PARAMS = ["cols", "hide", "sort", "dir", "customers", "types", "statuses", "billables", "actuals"] as const;

type MyViews = Record<string, ViewConfig>;

function readMyViews(): MyViews {
  try {
    const raw = window.localStorage.getItem(MY_VIEWS_KEY);
    return raw ? (JSON.parse(raw) as MyViews) : {};
  } catch {
    return {};
  }
}
function writeMyViews(v: MyViews) {
  window.localStorage.setItem(MY_VIEWS_KEY, JSON.stringify(v));
}

// Snapshot the CURRENT grid state into a ViewConfig — the URL params, and nothing
// else. It used to also read this tab's two Grid Size keys out of localStorage; see
// the note above for why zoom is not part of a view.
function snapshotView(): ViewConfig {
  const params: Record<string, string> = {};
  const sp = new URLSearchParams(window.location.search);
  for (const k of VIEW_PARAMS) {
    const val = sp.get(k);
    if (val !== null) params[k] = val;
  }
  // `actuals` rides along in params now. The ViewConfig field is kept only so
  // views saved before that change still restore their Actuals setting — see
  // applyView.
  return { params };
}

// Apply a view: a SOFT navigation to /quoted with the saved params.
//
// It used to end in window.location.assign — a full browser reload, refetching the
// document and the JS bundles and re-hydrating the whole app shell, which made
// picking a view the slowest control on this toolbar by a wide margin. That reload
// existed for one reason: ProjectsDisplayMenu restored grid density from localStorage
// in a MOUNT effect, so only a fresh page picked up the values a view had just
// written. 2026-08-03 fixed it by writing the two CSS custom properties here as well;
// §45 removed the density prefs altogether, so there is nothing left to restore and
// this is a plain router.push.
function applyView(name: string, config: ViewConfig, router: { push: (href: string) => void }) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(config.params)) sp.set(k, v);
  // Views saved before Actuals moved into the URL carry it as a config field
  // instead. Honour it, but never let it override a params value the same view
  // already has — a re-saved view carries both, and params is the current truth.
  if (config.actuals !== undefined && !sp.has("actuals")) {
    if (config.actuals) sp.set("actuals", "1");
  }
  sp.set("view", name); // label only — the page ignores it for data
  router.push(`/quoted?${sp.toString()}`);
}

export function ProjectViewsMenu({
  sharedViews,
  teamDefault,
}: {
  sharedViews: SharedView[];
  teamDefault: SharedView | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [mine, setMine] = useState<MyViews>({});
  const [busy, setBusy] = useState(false);
  const activeName = searchParams.get("view");

  useEffect(() => {
    // Deliberately an effect, not a lazy useState initializer: readMyViews()
    // reads window.localStorage, unavailable during the server render.
    // Reading it in the initializer would make the client's hydration
    // render disagree with the server's; deferring to an effect keeps
    // hydration matched and applies the real value in the harmless
    // re-render right after.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMine(readMyViews());
  }, []);

  // Click-outside-to-close, same pattern as the other toolbar dropdowns.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (detailsRef.current?.open && !detailsRef.current.contains(e.target as Node)) detailsRef.current.open = false;
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  function handleSaveMine() {
    const name = window.prompt("Name this view — it saves the visible columns, filters, sort and Actuals toggle. It stays private to you until you ★ share it.");
    if (!name || !name.trim()) return;
    const next = { ...readMyViews(), [name.trim()]: snapshotView() };
    writeMyViews(next);
    setMine(next);
    toast(`Saved view “${name.trim()}”`);
    close();
  }

  function handleDeleteMine(name: string) {
    const next = { ...readMyViews() };
    delete next[name];
    writeMyViews(next);
    setMine(next);
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

  function handlePublish(name: string, config: ViewConfig) {
    void run("Couldn't share this view.", async () => {
      await publishView(name, config);
      // Move it out of My views (it now lives in Shared), like the Scheduler.
      handleDeleteMine(name);
      toast(`Shared “${name}” with the team`);
    });
  }

  const sec = (label: string) => (
    <div className="px-3 pt-2 pb-1 text-label font-semibold uppercase tracking-wider text-sdc-gray-400">{label}</div>
  );
  const rowBtn =
    "flex-1 truncate rounded px-2 py-1 text-left text-xs hover:bg-sdc-gray-100";
  const iconBtn = "shrink-0 rounded px-1.5 text-note text-sdc-gray-400 hover:bg-sdc-gray-100 hover:text-sdc-navy";

  const myNames = Object.keys(mine).sort((a, b) => a.localeCompare(b));

  return (
    <details ref={detailsRef} className="group relative inline-block">
      <summary className={`${TOOLBAR_BTN} ${activeName ? TOOLBAR_BTN_ACTIVE : TOOLBAR_BTN_NEUTRAL}`}>
        {activeName ? `View: ${activeName}` : "Views"}
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 opacity-70 motion-interactive group-open:rotate-180">
          <path d="M3.5 6 L8 10.5 L12.5 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="motion-menu-panel absolute left-0 top-full z-30 mt-2 w-64 rounded-lg border border-sdc-border bg-white py-1 shadow-lg">
        {teamDefault && (
          <div className="col-view-row flex items-center gap-1 px-2">
            <button
              type="button"
              onClick={() => applyView("Team Default", teamDefault.config, router)}
              className="flex-1 truncate rounded border-y-2 border-sdc-blue-100 px-2 py-1 text-left text-xs font-semibold text-sdc-navy hover:bg-sdc-blue-light"
            >
              Team Default
            </button>
            <button type="button" title="Clear the team default (affects everyone)" className={iconBtn} disabled={busy} onClick={() => run("Couldn't clear the default.", deleteTeamDefault)}>
              ✕
            </button>
          </div>
        )}

        {sharedViews.length > 0 && sec("Shared")}
        {sharedViews.map((v) => (
          <div key={v.name} className="col-view-row flex items-center gap-1 px-2">
            <button type="button" onClick={() => applyView(v.name, v.config, router)} className={rowBtn}>
              {v.name}
              {v.owner ? <span className="text-label text-sdc-gray-400"> · {v.owner}</span> : null}
            </button>
            <button type="button" title="Delete this shared view (affects everyone)" className={iconBtn} disabled={busy} onClick={() => {
              if (window.confirm(`Delete shared view “${v.name}”? This removes it for everyone.`)) run("Couldn't delete the view.", () => deleteSharedView(v.name));
            }}>
              ✕
            </button>
          </div>
        ))}

        {sec("My views")}
        {myNames.length ? (
          myNames.map((name) => (
            <div key={name} className="col-view-row flex items-center gap-1 px-2">
              <button type="button" onClick={() => applyView(name, mine[name], router)} className={rowBtn}>
                {name}
              </button>
              <button type="button" title="Share this view with everyone" className={iconBtn} disabled={busy} onClick={() => handlePublish(name, mine[name])}>
                ★
              </button>
              <button type="button" title="Delete this view" className={iconBtn} onClick={() => handleDeleteMine(name)}>
                ✕
              </button>
            </div>
          ))
        ) : (
          <div className="px-3 pb-1 text-xs text-sdc-gray-400">None yet.</div>
        )}

        <div className="my-1 border-t border-sdc-border-soft" />
        <button type="button" onClick={handleSaveMine} className="block w-full px-3 py-1.5 text-left text-xs font-semibold text-sdc-navy hover:bg-sdc-gray-100">
          + Save current as view…
        </button>
        <button type="button" disabled={busy} onClick={() => run("Couldn't set the default.", async () => { await setTeamDefault(snapshotView()); toast("Set as Team Default"); close(); })} className="block w-full px-3 py-1.5 text-left text-xs text-sdc-navy hover:bg-sdc-gray-100">
          Set current as Team Default
        </button>
      </div>
    </details>
  );
}
