import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import "./globals.css";
import SessionProvider from "@/components/SessionProvider";

// The SDC Brand Guide's web font — Montserrat is the guide's designated
// closest web-safe match to the brand print font (Core Sans NR), used app-wide
// (body + headings) so the UI is typographically on-brand and consistent.
// Body weights (400/500) plus headline weights (600/700).
const montserrat = Montserrat({
  variable: "--font-montserrat",
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SDC Projects Reports",
  description: "Project reporting and estimate-to-complete tracking for SDC projects",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${montserrat.variable} h-full antialiased`}
      // The pre-paint script below writes to this element's `style` attribute (the
      // zoom level) before React hydrates, so React's expected <html> — which has no
      // style attribute at all — can never match the DOM. That logged a hydration
      // error on EVERY page, ending in "This won't be patched up", which buries any
      // real mismatch in noise.
      //
      // This is the React-sanctioned escape for a deliberate, unavoidable
      // server/client difference, and the same thing next-themes does for the
      // identical problem. It is NOT a blanket silencer: it covers only this
      // element's own attributes and does not cascade to children, so a genuine
      // mismatch anywhere inside the app still reports.
      //
      // The alternative — moving the preference to a cookie so the server could
      // render the style itself — would remove the difference rather than excuse
      // it, but it changes where the preference lives and costs a cookie on every
      // request. Not worth it for a display preference.
      suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        {/* Restore the saved zoom level BEFORE first paint (§45).
            ONE preference now, where there used to be six: a root font-size and five
            grid density vars, each with its own key. See lib/app-zoom.ts.

            Inline and blocking on purpose: it has to run before the first paint,
            which rules out an effect and rules out `defer`. A zoom applied after
            paint is a zoom the user watches being applied — the whole interface
            would visibly jump on every page load.

            The 0.5/1 bounds are ZOOM_STEPS' first and last entries, duplicated
            here because this string cannot import anything.
            tests/app-zoom.test.ts asserts the two agree, so changing the range
            without touching this line fails the suite rather than silently
            clamping.

            `Math.round(n*10)/10` is snapZoom's normalization, inlined: the offered
            levels are an even 10% grid, so rounding to the nearest tenth lands on
            one of them, and it rounds halves UP exactly as snapZoom does — a saved
            0.75 from the old 75/80/90/100/110/125/150 list restores as 0.8, not
            0.7. Without it a retired level would paint at its own size and then
            disagree with the readout in the sidebar until the next click.

            Wrapped in try/catch because localStorage throws outright in some
            privacy modes, and a preference is never worth a blank page. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var r=localStorage.getItem('sdc-app-zoom-v1');if(r){var n=parseFloat(r);if(!isNaN(n))document.documentElement.style.setProperty('--app-zoom',String(Math.min(1,Math.max(0.5,Math.round(n*10)/10))));}}catch(e){}`,
          }}
        />
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
