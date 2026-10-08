import test from "node:test";
import assert from "node:assert/strict";
import { beginDrag, currentDrag, endDrag, watchDragEnd } from "../src/lib/drag-payload";

// The one-slot store that connects a dragged sidebar page or tab to the split view's
// drop targets. The only subtle part is WHEN it clears: a drop target reads the payload
// inside its own `drop` handler, and the window's capture-phase listener runs first.

const wait = () => new Promise((r) => setTimeout(r, 5));

/** A window stand-in: just enough of EventTarget for watchDragEnd. */
function fakeWindow() {
  const target = new EventTarget();
  return {
    win: target as unknown as Window,
    fire: (type: string) => target.dispatchEvent(new Event(type)),
  };
}

test("a drag is remembered until it ends", () => {
  endDrag();
  assert.equal(currentDrag(), null);
  beginDrag({ kind: "page", path: "/etc" });
  assert.deepEqual(currentDrag(), { kind: "page", path: "/etc" });
  endDrag();
  assert.equal(currentDrag(), null);
});

test("a drop clears the drag only AFTER the target has had its turn to read it", async () => {
  const { win, fire } = fakeWindow();
  const stop = watchDragEnd(win);
  beginDrag({ kind: "tab", id: "t2" });

  let seenByTarget: unknown = "never ran";
  (win as unknown as EventTarget).addEventListener("drop", () => {
    seenByTarget = currentDrag();
  });
  fire("drop");

  assert.deepEqual(seenByTarget, { kind: "tab", id: "t2" }, "the target's own handler still saw the payload");
  assert.deepEqual(currentDrag(), { kind: "tab", id: "t2" }, "and it is still there this tick");
  await wait();
  assert.equal(currentDrag(), null, "gone once the event has finished dispatching");
  stop();
});

test("dragend clears it too — the cancelled-drag case, with no drop at all", async () => {
  const { win, fire } = fakeWindow();
  const stop = watchDragEnd(win);
  beginDrag({ kind: "page", path: "/hours" });
  fire("dragend");
  await wait();
  assert.equal(currentDrag(), null);
  stop();
});

test("after the unsubscribe, the window no longer clears anything", async () => {
  const { win, fire } = fakeWindow();
  const stop = watchDragEnd(win);
  stop();
  beginDrag({ kind: "page", path: "/hours" });
  fire("drop");
  await wait();
  assert.deepEqual(currentDrag(), { kind: "page", path: "/hours" });
  endDrag();
});
