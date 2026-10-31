import { canTransition } from "../../xuanwu/coreDomainContracts.ts";
import type { WorkLedgerSnapshot, WorkTransitionCommand, WorkTransitionDecision, DependencyRelation, WorkLedgerEntry, ParentChildRelation } from "./contracts.model.ts";
import { validateWorkLedger, validateTransitionAudit } from "./contracts.validation.ts";

export function evaluateWorkTransition(
  snapshot: WorkLedgerSnapshot,
  command: WorkTransitionCommand
): WorkTransitionDecision {
  const violations = validateWorkLedger(snapshot);
  const work = snapshot.works.find((item) => item.id === command.work_id);
  if (!work) violations.push(`missing Work ${command.work_id}`);
  violations.push(...validateTransitionAudit(command.audit));
  if (!work) return decision(violations);

  if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) {
    violations.push("expected revision must be non-negative");
  } else if (command.expected_revision !== work.revision) {
    violations.push(`expected revision ${command.expected_revision} does not match ${work.revision}`);
  }
  if (!canTransition("work", work.status, command.to)) {
    violations.push(`illegal Work transition ${work.status} -> ${command.to}`);
  }
  if (command.audit.gate.decision === "deny") violations.push("transition gate denied");
  if (command.audit.gate.decision === "ask") violations.push("transition gate requires approval");

  const dependencies = snapshot.relations
    .filter((relation): relation is DependencyRelation => relation.kind === "depends_on" && relation.work_id === work.id)
    .map((relation) => snapshot.works.find((item) => item.id === relation.depends_on_work_id))
    .filter((item): item is WorkLedgerEntry => Boolean(item));
  if (["in_progress", "needs_user", "done"].includes(command.to)) {
    for (const dependency of dependencies) {
      if (dependency.status !== "done") violations.push(`dependency ${dependency.id} is ${dependency.status}, not done`);
    }
  }

  if (command.to === "done") {
    const children = snapshot.relations
      .filter((relation): relation is ParentChildRelation => relation.kind === "parent_child" && relation.parent_work_id === work.id)
      .map((relation) => snapshot.works.find((item) => item.id === relation.child_work_id))
      .filter((item): item is WorkLedgerEntry => Boolean(item));
    for (const child of children) {
      if (child.status !== "done") violations.push(`child ${child.id} is ${child.status}, not done`);
    }
  }

  // PI owns the semantic completion decision. Evidence and Handoff are context,
  // not a second deterministic completion gate.
  return decision(violations);
}

export function decision(violations: string[]): WorkTransitionDecision {
  return { allowed: violations.length === 0, violations: [...new Set(violations)] };
}
