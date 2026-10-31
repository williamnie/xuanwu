import type { RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { evaluateWorkTransition } from "./contracts.ts";
import { errorMessage } from "../../util/values.ts";
import {
  type IssueWorkCreateCommand,
  type IssueWorkMutationResult,
  type IssueWorkUpdateCommand,
  type IssueWorkActionCommand
} from "./issueAdapterModel.ts";
import {
  auditViolations,
  createViolations,
  createFingerprint,
  mutationFingerprint,
  revisionViolations,
  patchViolations,
  issuePatch,
  actionTargetStatus,
  applyLegacyIssueAction
} from "./issueAdapterValidation.ts";
import {
  replayIssueWorkCreate,
  replayAdapterWrite,
  mustGetIssueWork,
  rejectAdapterWrite,
  recordAdapterWrite
} from "./issueAdapterAudit.ts";
import { projectIssueAsWork, workIDToIssueID } from "./issueAdapterProjection.ts";

export function createIssueBackedWork(
  db: RunnerDatabase,
  command: IssueWorkCreateCommand
): IssueWorkMutationResult {
  const violations = [
    ...auditViolations(command.audit),
    ...createViolations(command)
  ];
  if (violations.length > 0) throw new Error([...new Set(violations)].join("; "));
  const fingerprint = createFingerprint(command);
  return db.transaction((): IssueWorkMutationResult => {
    const replay = replayIssueWorkCreate(db, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const issue = createIssue(db, {
      agent_profile_id: command.agent_profile_id,
      depends_on_issue_ids: command.depends_on_issue_ids,
      description: command.goal,
      project_id: command.project_id,
      status: command.status,
      title: command.title
    }, {
      createdEventPayload: {
        actor: command.audit.actor,
        correlation_id: command.audit.correlation_id,
        event_id: command.audit.event_id,
        fingerprint,
        gate: command.audit.gate,
        operation: "create",
        outcome: "applied",
        reason: command.audit.reason,
        ...(command.source ? { source: command.source } : {})
      }
    });
    return {
      applied: true,
      audit_event_id: command.audit.event_id,
      violations: [],
      work: projectIssueAsWork(db, issue)
    };
  }).immediate();
}

export function updateIssueBackedWork(
  db: RunnerDatabase,
  command: IssueWorkUpdateCommand
): IssueWorkMutationResult {
  const fingerprint = mutationFingerprint("update", command);
  const issueID = workIDToIssueID(command.work_id);
  return db.transaction((): IssueWorkMutationResult => {
    const replay = replayAdapterWrite(db, issueID, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const before = mustGetIssueWork(db, issueID);
    const violations = [
      ...auditViolations(command.audit),
      ...revisionViolations(command.expected_revision, before.revision),
      ...patchViolations(command.patch)
    ];
    if (before.status === "in_progress" && command.patch.agent_profile_id !== undefined &&
        command.patch.agent_profile_id !== before.agent_profile_id) {
      violations.push("running Work agent_profile_id cannot be changed");
    }
    if (violations.length > 0) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, "update", violations, command.patch);
    }
    try {
      updateIssue(db, issueID, issuePatch(command.patch));
    } catch (error) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, "update", [errorMessage(error)], command.patch);
    }
    const after = mustGetIssueWork(db, issueID);
    recordAdapterWrite(db, issueID, command.audit, fingerprint, "update", "applied", [], before, after, command.patch);
    return { applied: true, audit_event_id: command.audit.event_id, violations: [], work: after };
  }).immediate();
}

export function applyIssueWorkAction(
  db: RunnerDatabase,
  command: IssueWorkActionCommand
): IssueWorkMutationResult {
  const fingerprint = mutationFingerprint("action", command);
  const issueID = workIDToIssueID(command.work_id);
  return db.transaction((): IssueWorkMutationResult => {
    const replay = replayAdapterWrite(db, issueID, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const before = mustGetIssueWork(db, issueID);
    const target = actionTargetStatus(command.action);
    const idempotentEnqueue = command.action === "enqueue" && before.status === "todo";
    const decision = evaluateWorkTransition({ relations: [], works: [before] }, {
      audit: command.audit,
      expected_revision: command.expected_revision,
      to: target,
      work_id: before.id
    });
    const violations = idempotentEnqueue
      ? decision.violations.filter((violation) => violation !== "illegal Work transition todo -> todo")
      : decision.violations;
    if (violations.length > 0) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, command.action, violations, { to: target });
    }
    if (!idempotentEnqueue) {
      try {
        applyLegacyIssueAction(db, issueID, command.action, command.audit.reason);
      } catch (error) {
        return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, command.action, [errorMessage(error)], { to: target });
      }
    }
    const after = mustGetIssueWork(db, issueID);
    if (after.status !== target) {
      return rejectAdapterWrite(db, issueID, after, command.audit, fingerprint, command.action,
        [`legacy Issue action left status ${after.status}; expected ${target}`], { to: target });
    }
    recordAdapterWrite(db, issueID, command.audit, fingerprint, command.action, "applied", [], before, after, {
      ...(idempotentEnqueue ? { idempotent: true } : {}),
      to: target
    });
    return { applied: true, audit_event_id: command.audit.event_id, violations: [], work: after };
  }).immediate();
}

export type { IssueWorkAction } from "./issueAdapterModel.ts";
export type { IssueWorkMutationResult } from "./issueAdapterModel.ts";
export { issueIDToWorkID } from "./issueAdapterProjection.ts";
export { workIDToIssueID } from "./issueAdapterProjection.ts";
export { getIssueBackedWork } from "./issueAdapterProjection.ts";
export { getIssueAsWork } from "./issueAdapterProjection.ts";
export { listIssueBackedWorks } from "./issueAdapterProjection.ts";
export { countIssueBackedWorks } from "./issueAdapterProjection.ts";
export { projectIssueAsWork } from "./issueAdapterProjection.ts";
export { issueAsWork } from "./issueAdapterProjection.ts";
export { issueStatusToWorkStatus } from "./issueAdapterProjection.ts";
