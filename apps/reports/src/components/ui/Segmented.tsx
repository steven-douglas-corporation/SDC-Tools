"use client";

// A small either/or switch: two or three options in one bordered pill, the chosen one tinted.
// First built inside Job Details' Procurement (Group By: PO / Part, List / Card) and shared so
// other pages that offer the same kind of choice draw it the same way. Pair it with a short
// uppercase label saying WHAT is being chosen ("View", "Group by"); the options alone don't.

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; title?: string }[];
  /** What is being chosen, for screen readers. */
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-8 items-center rounded-md border border-sdc-border bg-white p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          title={o.title}
          className={`h-7 rounded px-2.5 text-xs font-medium motion-interactive ${
            value === o.value ? "bg-sdc-blue-light text-sdc-blue-dark" : "text-sdc-gray-600 hover:text-sdc-navy"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
