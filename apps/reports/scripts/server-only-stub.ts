// A do-nothing stand-in for Next's `server-only` marker package.
//
// Several lib modules `import "server-only"` so that a stray client import fails
// the build. That marker is resolved by Next's bundler alias and does not exist as
// a real module, so any of those files is unimportable from a plain `tsx` script —
// which is why the perf baseline could not call the same query helpers the pages
// call, and why the repo's tests avoid those modules entirely (see DEVLOG §15).
//
// tsconfig.scripts.json maps `server-only` here for scripts ONLY. The app's own
// tsconfig is untouched, so the real guard still applies to everything Next builds.
export {};
