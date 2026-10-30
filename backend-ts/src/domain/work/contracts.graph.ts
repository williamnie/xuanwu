import { type WorkID } from "../../xuanwu/coreDomainContracts.ts";

export function hasDirectedCycle(nodes: readonly WorkID[], edges: ReadonlyArray<readonly [WorkID, WorkID]>): boolean {
  const adjacent = new Map(nodes.map((node) => [node, [] as WorkID[]]));
  for (const [from, to] of edges) adjacent.get(from)?.push(to);
  const active = new Set<WorkID>();
  const complete = new Set<WorkID>();
  const visit = (node: WorkID): boolean => {
    if (active.has(node)) return true;
    if (complete.has(node)) return false;
    active.add(node);
    for (const next of adjacent.get(node) ?? []) if (visit(next)) return true;
    active.delete(node);
    complete.add(node);
    return false;
  };
  return nodes.some(visit);
}
