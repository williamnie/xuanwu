import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { enqueueIssue, retryIssue, cancelIssue } from "../../db/repositories/issueActions.ts";
import { type Issue } from "../../db/repositories/issues.ts";
import { type AgentRecommendation } from "../../pi/runtime/agentOrchestration.ts";
import { type WorkLedgerEntry, type WorkStatus, type WorkTransitionAudit } from "./contracts.ts";
import {
  type IssueWorkAction,
  type IssueWorkPatch,
  type IssueWorkCreateCommand,
  type IssueWorkUpdateCommand,
  type IssueWorkActionCommand,
  stableJson
} from "./issueAdapterModel.ts";

export function actionTargetStatus(action: IssueWorkAction): WorkStatus {
  return action === "cancel" ? "cancelled" : "todo";
}

export function applyLegacyIssueAction(db: RunnerDatabase, issueID: number, action: IssueWorkAction, reason: string): Issue {
  if (action === "enqueue") return enqueueIssue(db, issueID);
  if (action === "retry") return retryIssue(db, issueID);
  return cancelIssue(db, issueID, reason);
}

export function issuePatch(patch: IssueWorkPatch): {
  agent_profile_id?: string;
  depends_on_issue_ids?: number[];
  description?: string;
  title?: string;
} {
  return {
    ...(patch.agent_profile_id !== undefined ? { agent_profile_id: patch.agent_profile_id } : {}),
    ...(patch.depends_on_issue_ids !== undefined ? { depends_on_issue_ids: patch.depends_on_issue_ids } : {}),
    ...(patch.goal !== undefined ? { description: patch.goal } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {})
  };
}

export function patchViolations(patch: IssueWorkPatch): string[] {
  const keys = Object.keys(patch);
  const violations: string[] = [];
  const unsupported = keys.filter((key) => (
    key !== "agent_profile_id" && key !== "depends_on_issue_ids" && key !== "goal" && key !== "title"
  ));
  if (unsupported.length > 0) violations.push(`unsupported Issue-backed Work fields: ${unsupported.join(", ")}`);
  if (keys.length === 0) violations.push("Issue-backed Work patch is empty");
  if (patch.title !== undefined && patch.title.trim() === "") violations.push("Work title is required");
  if (patch.goal !== undefined && patch.goal.trim() === "") violations.push("Work goal is required");
  return violations;
}

export function effectiveAgentProfile(issue: Issue, selection: AgentRecommendation): NonNullable<WorkLedgerEntry["effective_agent_profile"]> {
  const reason = selection.selection_reason;
  const source = issue.agent_profile_id
    ? "work"
    : reason.startsWith("project default_agent_profile_id")
      ? "project_default"
      : selection.profile_id
        ? "strategy"
        : "project_provider";
  return {
    id: selection.profile_id,
    model: selection.model,
    name: selection.profile_name,
    provider: selection.provider,
    selection_reason: reason,
    source
  };
}

export function createViolations(command: IssueWorkCreateCommand): string[] {
  const violations: string[] = [];
  if (!command.project_id.trim()) violations.push("project_id is required");
  if (!command.goal.trim()) violations.push("Work goal is required");
  if (command.type !== "engineering_task") {
    violations.push("Issue-backed Work type must be engineering_task");
  }
  if (command.status !== "triage" && command.status !== "todo" &&
    !(command.status === "in_progress" && command.source?.kind === "automation_trigger")) {
    violations.push("Issue-backed Work must be created in triage or todo unless a governed Automation dispatch starts its Run");
  }
  return violations;
}

export function auditViolations(audit: WorkTransitionAudit): string[] {
  const violations: string[] = [];
  if (!audit.event_id.trim()) violations.push("event_id is required");
  if (!audit.actor.id.trim()) violations.push("actor.id is required");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(audit.actor.kind)) {
    violations.push("actor.kind is invalid");
  }
  if (!audit.reason.trim()) violations.push("reason is required");
  if (!audit.correlation_id.trim()) violations.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) violations.push("occurred_at must be a timestamp");
  if (audit.gate.authority !== "deterministic_policy" && audit.gate.authority !== "human_approval") {
    violations.push("gate authority is not trusted");
  }
  if (audit.gate.decision === "deny") violations.push("mutation gate denied");
  if (audit.gate.decision === "ask") violations.push("mutation gate requires approval");
  if (audit.gate.decision !== "allow" && audit.gate.decision !== "deny" && audit.gate.decision !== "ask") {
    violations.push("gate decision is invalid");
  }
  if (!audit.gate.policy_ref.trim()) violations.push("gate policy_ref is required");
  return violations;
}

export function revisionViolations(expected: number, actual: number): string[] {
  if (!Number.isSafeInteger(expected) || expected < 0) return ["expected revision must be a non-negative integer"];
  return expected === actual ? [] : [`expected revision ${expected} does not match ${actual}`];
}

export function mutationFingerprint(operation: string, command: IssueWorkUpdateCommand | IssueWorkActionCommand): string {
  const body = "patch" in command
    ? { operation, work_id: command.work_id, expected_revision: command.expected_revision, patch: command.patch, audit: command.audit }
    : { operation, work_id: command.work_id, expected_revision: command.expected_revision, action: command.action, audit: command.audit };
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function createFingerprint(command: IssueWorkCreateCommand): string {
  return createHash("sha256").update(stableJson({ command, operation: "create" })).digest("hex");
}
