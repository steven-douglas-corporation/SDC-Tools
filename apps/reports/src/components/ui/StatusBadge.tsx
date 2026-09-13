// One badge component for every colored pill in the app — job status, ETC
// review/confirm state, and generic neutral tags (source, type) all pick a
// variant instead of each page hand-rolling its own conditional classes.
const VARIANT_CLASSES = {
  active: "bg-sdc-blue-light text-sdc-blue-dark",
  complete: "bg-sdc-green-bg text-sdc-green-text",
  needsReview: "bg-sdc-yellow-bg text-sdc-yellow-text",
  confirmed: "bg-sdc-green-bg text-sdc-green-text",
  locked: "bg-sdc-gray-100 text-sdc-gray-700",
  notStarted: "bg-sdc-gray-100 text-sdc-gray-600",
  neutral: "bg-sdc-gray-100 text-sdc-gray-600",
  failed: "bg-sdc-red-bg text-sdc-red-text",
} as const;

export type StatusVariant = keyof typeof VARIANT_CLASSES;

export function StatusBadge({
  variant,
  children,
  style,
}: {
  variant: StatusVariant;
  children: React.ReactNode;
  // Inline, not a className override — text-xs is baked into the base
  // classes below, and a second conflicting Tailwind font-size utility
  // class would race it for the same CSS property with no guaranteed
  // winner (bit us once already this session with `sticky`/`relative`).
  // An inline style always wins regardless of Tailwind's generated order.
  style?: React.CSSProperties;
}) {
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]}`} style={style}>
      {children}
    </span>
  );
}
