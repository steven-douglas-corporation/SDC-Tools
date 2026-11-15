// What a dependency means once cards can sit under other cards. No database here: the forecast
// run and the loop check both hand in plain rows, so the rule has one implementation and a test.
//
// A dependency is stored between the two cards a person linked, whatever they are. Only cards
// with nothing under them carry work, so when either end has cards under it the link stands for
// every such card beneath it:
//
//   "Feature B waits on Feature A"  =  every work card under B waits on every work card under A.
//
// A card with nothing under it stands for itself.

export interface DependencyLink {
  predecessorId: number;
  successorId: number;
  lagDays: number;
}

/** The cards directly under each card. Pass only unarchived cards. */
export function childrenByParent(links: { id: number; parentId: number | null }[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const l of links) {
    if (l.parentId == null) continue;
    const list = children.get(l.parentId);
    if (list) list.push(l.id);
    else children.set(l.parentId, [l.id]);
  }
  return children;
}

/** The cards that carry work at or under a card: itself when nothing sits under it. */
export function workCardsUnder(id: number, children: Map<number, number[]>): number[] {
  const found: number[] = [];
  const stack = [id];
  while (stack.length) {
    const next = stack.pop() as number;
    const kids = children.get(next);
    if (kids?.length) stack.push(...kids);
    else found.push(next);
  }
  return found;
}

/**
 * Turns the stored links into links between cards that carry work. When two stored links
 * produce the same pair, the longer lag is kept.
 */
export function expandDependencies(links: DependencyLink[], children: Map<number, number[]>): DependencyLink[] {
  const byPair = new Map<string, DependencyLink>();
  for (const link of links) {
    const before = workCardsUnder(link.predecessorId, children);
    const after = workCardsUnder(link.successorId, children);
    for (const successorId of after) {
      for (const predecessorId of before) {
        if (predecessorId === successorId) continue;
        const key = `${predecessorId}>${successorId}`;
        const seen = byPair.get(key);
        if (!seen || link.lagDays > seen.lagDays)
          byPair.set(key, { predecessorId, successorId, lagDays: link.lagDays });
      }
    }
  }
  return [...byPair.values()];
}

/** True when `a` sits somewhere under `b`, or `b` under `a`. */
export function inSameLine(a: number, b: number, children: Map<number, number[]>): boolean {
  const under = (top: number, target: number): boolean => {
    const stack = [...(children.get(top) ?? [])];
    while (stack.length) {
      const next = stack.pop() as number;
      if (next === target) return true;
      stack.push(...(children.get(next) ?? []));
    }
    return false;
  };
  return under(a, b) || under(b, a);
}

/**
 * Would adding `candidate` to `existing` make a loop among the cards that carry work? A loop
 * can hide in the hierarchy: "B waits on A" plus "a card under A waits on a card under B".
 */
export function wouldLoop(
  existing: DependencyLink[],
  candidate: DependencyLink,
  children: Map<number, number[]>,
): boolean {
  const waitsOn = new Map<number, number[]>();
  for (const l of expandDependencies([...existing, candidate], children)) {
    const list = waitsOn.get(l.successorId);
    if (list) list.push(l.predecessorId);
    else waitsOn.set(l.successorId, [l.predecessorId]);
  }
  // Any loop the new link creates passes through one of the work cards on its waiting side.
  const state = new Map<number, 1 | 2>(); // 1 = on the current path, 2 = finished
  const visit = (id: number): boolean => {
    const seen = state.get(id);
    if (seen === 1) return true;
    if (seen === 2) return false;
    state.set(id, 1);
    for (const next of waitsOn.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return workCardsUnder(candidate.successorId, children).some(visit);
}
