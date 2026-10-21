import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAZY_CHUNK, clampVisible, firstVisible, nextVisible } from "../src/lib/lazy-rows";

// ── The Data Management punch table draws in chunks (2026-10-21) ─────────────
//
// Up to 3,000 rows come from the server; the table used to draw all of them. It now
// draws the first chunk and adds the next as the bottom of its scroll box comes into
// view. The arithmetic is below; the second half pins the parts of the component that
// are easy to break without anything failing — a sort that only reorders what is drawn,
// or a sentinel that watches the page instead of the table.

test("the first draw is one chunk, or everything when there is less than that", () => {
  assert.equal(firstVisible(3000), LAZY_CHUNK);
  assert.equal(firstVisible(LAZY_CHUNK), LAZY_CHUNK);
  assert.equal(firstVisible(7), 7);
  assert.equal(firstVisible(0), 0);
});

test("each request adds a chunk and stops at the last row", () => {
  assert.equal(nextVisible(100, 3000), 200);
  assert.equal(nextVisible(2950, 3000), 3000);
  assert.equal(nextVisible(3000, 3000), 3000, "asking again at the end changes nothing");
  assert.equal(nextVisible(0, 250), 100);
  // Walking all the way down always lands exactly on the total, never past it.
  let n = firstVisible(1234);
  for (let i = 0; i < 20; i++) n = nextVisible(n, 1234);
  assert.equal(n, 1234);
});

test("nonsense in gives nothing out rather than NaN rows", () => {
  for (const total of [0, -5, NaN, Infinity]) {
    assert.equal(firstVisible(total), 0, `firstVisible(${total})`);
    assert.equal(nextVisible(100, total), 0, `nextVisible(100, ${total})`);
  }
  assert.equal(nextVisible(NaN, 500), LAZY_CHUNK);
  assert.equal(nextVisible(-40, 500), LAZY_CHUNK);
});

test("a stored count is clamped to the rows that exist and never below the first chunk", () => {
  // The rows can shrink under a mounted table (a refresh with the same filters).
  assert.equal(clampVisible(2000, 300), 300);
  assert.equal(clampVisible(0, 300), LAZY_CHUNK, "never below the first chunk");
  assert.equal(clampVisible(0, 40), 40);
  assert.equal(clampVisible(150, 3000), 150);
  assert.equal(clampVisible(NaN, 3000), LAZY_CHUNK);
  assert.equal(clampVisible(500, 0), 0);
});

// ── The component ───────────────────────────────────────────────────────────

const explorer = readFileSync(join(import.meta.dirname, "..", "src", "components", "DataQualityExplorer.tsx"), "utf8");
const code = explorer.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/[^\n]*/g, "");

test("the whole row set is sorted first and only then cut down to what is drawn", () => {
  const sortAt = code.indexOf("sortRows(data.rows, sort.sort, PUNCH_ROW_COLUMNS)");
  const sliceAt = code.indexOf("sortedRows.slice(0, visibleCount)");
  assert.ok(sortAt > -1 && sliceAt > sortAt, "sort over every row, then slice");
  assert.match(code, /visibleRows\.map\(/, "the table body draws the slice");
  assert.doesNotMatch(code, /sortedRows\.map\(/, "the table body must not draw every row");
});

test("the sentinel sits inside the scroll box, which is the observer's root", () => {
  assert.match(code, /new IntersectionObserver\([\s\S]*?\{ root, rootMargin/);
  assert.match(code, /const root = scrollRef\.current/);
  const boxAt = code.indexOf("ref={scrollRef}");
  const sentinelAt = code.indexOf("ref={sentinelRef}");
  const boxCloseAt = code.indexOf("</table>");
  assert.ok(boxAt > -1 && sentinelAt > boxCloseAt, "sentinel comes after the table, still inside the scroll box");
});

test("the table goes back to the first chunk and the top when the list changes, and not on a refresh", () => {
  assert.match(code, /const listKey = `\$\{url\.searchKey\}\|\$\{sort\.sort\?\.key/);
  assert.match(code, /if \(drawn\.key !== listKey\) setDrawn\(\{ count: LAZY_CHUNK, key: listKey \}\)/);
  assert.match(code, /scrollRef\.current\?\.scrollTo\(\{ top: 0 \}\)/);
  // Keyed on the params and the sort, not on the `data` object, which is new on every refresh.
  assert.doesNotMatch(code.slice(code.indexOf("const listKey"), code.indexOf("const listKey") + 200), /data\./);
});

test("there is a way to load more without an IntersectionObserver", () => {
  assert.match(code, /typeof IntersectionObserver === "undefined"/);
  assert.match(code, /onClick=\{\(\) => setDrawn\(\(d\) => \(\{ \.\.\.d, count: nextVisible\(d\.count, sortedRows\.length\) \}\)\)\}/);
});
