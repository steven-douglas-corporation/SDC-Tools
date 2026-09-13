// THE single source of the application version.
//
// The number itself lives in package.json (the one place a version already had to
// be maintained) and is injected at build time by next.config.ts as
// NEXT_PUBLIC_APP_VERSION. Nothing else in the app may declare a version — that is
// the whole point of this file existing rather than a string in the sidebar.
//
// Why not import package.json here: this module is read by a CLIENT component (the
// sidebar), and importing package.json would bundle the entire dependency list into
// the browser payload. The build-time env var carries the one field that is wanted.
//
// Deployment: bump `version` in package.json, then `npm run build`. The value is
// baked into the bundle at build time, so a running process keeps reporting the
// version it was built from — which is the correct behaviour for "what am I
// actually running".
export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0-dev";

// What the UI shows. Kept here so every surface that displays it — the sidebar
// today, an About dialog or an audit record tomorrow — formats it identically.
export function appVersionLabel(): string {
  return `Version ${APP_VERSION}`;
}
