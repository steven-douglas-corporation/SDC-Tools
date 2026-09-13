import Link from "next/link";

// App-wide 404 — the app had none, so an unknown URL hit Next's bare default.
export default function NotFound() {
  return (
    <div className="flex min-h-[var(--app-vh)] items-center justify-center bg-background p-8">
      <div className="max-w-md rounded-xl border border-sdc-border bg-white p-8 text-center shadow-sm">
        <p className="font-heading text-4xl font-bold tracking-tight text-sdc-navy">404</p>
        <h1 className="mt-2 text-base font-semibold text-sdc-navy">Page not found</h1>
        <p className="mt-1 mb-5 text-sm text-sdc-muted">
          That page doesn&apos;t exist or may have moved.
        </p>
        <Link
          href="/"
          className="inline-block rounded-lg bg-sdc-blue px-4 py-2 text-sm font-semibold text-white hover:bg-sdc-blue-dark"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
