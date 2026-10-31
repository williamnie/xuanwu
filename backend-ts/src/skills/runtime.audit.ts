import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { type ToolCallAuditContext } from "../pi/actions/toolCallAudit.ts";
import { cleanString } from "../util/values.ts";
import { SkillRuntimeError } from "./runtime.model.ts";
import type { JsonObject, ExecuteSkillRuntimeInput } from "./runtime.model.ts";

export function recordRunEvent(
  db: RunnerDatabase,
  audit: ToolCallAuditContext,
  runID: string,
  eventType: string,
  status: string,
  payload: JsonObject,
  error = ""
): void {
  createPiActionEvent(db, {
    action_id: runID,
    actor: "skill_runtime",
    conversation_id: audit.conversationID,
    decision: status,
    error,
    event_type: eventType,
    issue_id: audit.issueID ?? 0,
    payload_json: JSON.stringify({ ...payload, status }),
    project_id: audit.projectID,
    reason: `skill runtime ${status}`
  });
}

export function auditContext(input: ExecuteSkillRuntimeInput): ToolCallAuditContext {
  return {
    conversationID: cleanString(input.auditContext?.conversationID),
    delegationID: cleanString(input.auditContext?.delegationID),
    heartbeatID: cleanString(input.auditContext?.heartbeatID),
    issueID: input.auditContext?.issueID,
    projectID: cleanString(input.auditContext?.projectID),
    source: cleanString(input.auditContext?.source) || "skill_runtime"
  };
}

export function normalizeFailure(error: unknown): { code: string; message: string; status: "failed" | "timeout" } {
  const code = error instanceof SkillRuntimeError ? error.code : "handler_failed";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    status: code === "skill_timeout" ? "timeout" : "failed"
  };
}
