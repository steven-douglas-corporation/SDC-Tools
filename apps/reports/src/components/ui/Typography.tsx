// Montserrat Bold heading scale per the SDC Brand Guide's web spec, applied once
// here instead of copy-pasted into every page's <h1>/<h2>.
export function PageTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h1 className={`font-heading text-2xl font-bold tracking-tight text-sdc-navy text-balance ${className}`}>{children}</h1>;
}

export function SectionTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`font-heading text-base font-semibold tracking-tight text-sdc-navy ${className}`}>{children}</h2>;
}
