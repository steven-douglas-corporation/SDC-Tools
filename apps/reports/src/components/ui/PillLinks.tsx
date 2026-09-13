import Link from "next/link";

// Generic single-select pill-link row, driven entirely by the href each item
// carries (query-param state) — no client JS. Replaces the near-identical
// month-tab and status-filter markup that used to be hand-rolled per page.
export function PillLinks({
  items,
}: {
  items: { key: string; label: string; href: string; active: boolean }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={
            item.active
              ? "rounded-full bg-sdc-blue px-3 py-1 text-xs font-medium text-white"
              : "rounded-full border border-sdc-border bg-white px-3 py-1 text-xs font-medium text-sdc-gray-600 hover:bg-sdc-blue-light"
          }
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}
