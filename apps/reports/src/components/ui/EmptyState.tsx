import type { ReactNode } from "react";

// Shared empty / unavailable / no-data card, so every page stops hand-rolling
// its own. `tone` distinguishes a normal empty state (neutral) from a
// data-source failure (warning) — the two used to look identical or, worse, a
// failure rendered as blank ("no data") which is materially misleading.
export function EmptyState({
  title,
  message,
  tone = "neutral",
  icon,
  action,
  className = "",
}: {
  title: string;
  message?: string;
  tone?: "neutral" | "warning";
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const warn = tone === "warning";
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-xl border px-6 py-10 text-center ${
        warn ? "border-sdc-red-border bg-sdc-red-bg/40" : "border-sdc-border bg-white"
      } ${className}`}
    >
      <span className={warn ? "text-sdc-red-text" : "text-sdc-gray-400"}>
        {icon ?? (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7">
            {warn ? (
              <>
                <path d="M12 3 L22 20 H2 Z" strokeLinejoin="round" />
                <line x1="12" y1="9" x2="12" y2="14" strokeLinecap="round" />
                <line x1="12" y1="17" x2="12" y2="17" strokeLinecap="round" />
              </>
            ) : (
              <>
                <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
                <line x1="3.5" y1="9" x2="20.5" y2="9" />
              </>
            )}
          </svg>
        )}
      </span>
      <p className={`text-sm font-semibold ${warn ? "text-sdc-red-text" : "text-sdc-navy"}`}>{title}</p>
      {message && <p className="max-w-md text-xs text-sdc-muted">{message}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
