import type { AttentionInboxItemRecord } from "../../db/repositories/intakeRuns.ts";
import type { PiApprovalRequest } from "../../db/repositories/pi/approvalRequests.ts";
import type { PiGuardianAlert } from "../../db/repositories/pi/guardianAlerts.ts";
import type {
  AttentionCandidate,
  AttentionSeverity,
  AttentionSourceRef,
  AttentionStatus,
  AttentionType
} from "./contracts.ts";

export function attentionFromInboxItem(item: AttentionInboxItemRecord): AttentionCandidate {
  const type = inboxType(item);
  return {
    created_at: item.created_at,
    evidence_refs: item.evidence_refs,
    next_action: inboxNextAction(type),
    owner: projectOwner(projectIDFromInbox(item)),
    reason_code: clean(item.primary_intent) || type,
    related_refs: [`context_bundles:${item.bundle_id}`, `intake_runs:${item.intake_run_id}`],
    required_actor: requiredActor(type),
    severity: severity(item.urgency),
    source_ref: sourceRef(
      "attention_inbox_items",
      item.id,
      item.status,
      inboxResolution(item.status),
      inboxCorrelations(item)
    ),
    status: inboxStatus(item.status),
    summary: item.summary,
    type,
    updated_at: item.updated_at
  };
}

export function attentionFromGuardianAlert(alert: PiGuardianAlert): AttentionCandidate {
  const type = guardianType(alert.alert_type);
  return {
    created_at: alert.created_at,
    evidence_refs: jsonStringList(alert.evidence_json),
    next_action: type === "connection_issue" ? "restore and verify the affected connection" : "inspect and remediate the runtime failure",
    owner: projectOwner(alert.project_id),
    reason_code: clean(alert.alert_type) || type,
    related_refs: [],
    required_actor: "operator",
    severity: severity(alert.severity),
    source_ref: sourceRef(
      "pi_guardian_alerts",
      alert.id,
      alert.status,
      guardianResolution(alert.status),
      guardianCorrelations(alert)
    ),
    status: guardianStatus(alert.status),
    summary: alert.message,
    type,
    updated_at: alert.updated_at
  };
}

export function attentionFromApprovalRequest(request: PiApprovalRequest): AttentionCandidate {
  return {
    created_at: request.created_at,
    evidence_refs: [],
    next_action: "review and decide the approval request",
    owner: projectOwner(request.project_id),
    reason_code: clean(request.request_type) || "approval_required",
    related_refs: compact([
      request.run_id ? `run:${request.run_id}` : "",
      request.session_id ? `session:${request.session_id}` : ""
    ]),
    required_actor: "approver",
    severity: severity(request.risk),
    source_ref: sourceRef(
      "pi_approval_requests",
      request.approval_id,
      request.status,
      approvalResolution(request.status),
      approvalCorrelations(request)
    ),
    status: request.status === "pending" ? "waiting" : "resolved",
    summary: request.summary || request.request_summary || "Approval required",
    type: "approval_required",
    updated_at: request.updated_at
  };
}

function inboxType(item: AttentionInboxItemRecord): AttentionType {
  const signal = `${item.primary_intent} ${item.secondary_intents.join(" ")} ${item.suggested_actions.join(" ")}`.toLowerCase();
  if (item.status === "failed" || /fail|error/.test(signal)) return "failure";
  if (/approval|approve|permission/.test(signal)) return "approval_required";
  if (/clarif|ask_user|input|reply/.test(signal)) return "input_required";
  if (/verif|review|accept/.test(signal)) return "verification_required";
  if (/connect|provider|auth|heartbeat|watchdog/.test(signal)) return "connection_issue";
  return "blocker";
}

function guardianType(alertType: string): AttentionType {
  return /connect|provider|auth|heartbeat|watchdog|unavailable/i.test(alertType)
    ? "connection_issue"
    : "failure";
}

function inboxStatus(status: string): AttentionStatus {
  switch (status) {
    case "triaged": return "acknowledged";
    case "proposal_created": return "waiting";
    case "actioned": return "resolved";
    case "ignored": return "dismissed";
    default: return "open";
  }
}

function guardianStatus(status: string): AttentionStatus {
  switch (status) {
    case "acked": return "acknowledged";
    case "resolved": return "resolved";
    case "suppressed": return "dismissed";
    default: return "open";
  }
}

function inboxResolution(status: string): AttentionSourceRef["resolution"] {
  if (status === "actioned") return "resolved";
  if (status === "ignored") return "dismissed";
  return "active";
}

function guardianResolution(status: string): AttentionSourceRef["resolution"] {
  if (status === "resolved") return "resolved";
  if (status === "suppressed") return "dismissed";
  return "active";
}

function approvalResolution(status: string): AttentionSourceRef["resolution"] {
  return status === "pending" ? "active" : "resolved";
}

function inboxCorrelations(item: AttentionInboxItemRecord): string[] {
  const schema = item.schema_item as Record<string, unknown>;
  return compact([
    prefixed("approval", schema.approval_id),
    prefixed("run", schema.run_id),
    prefixed("issue", schema.issue_id),
    prefixed("work", schema.work_id),
    prefixed("conversation", schema.conversation_id),
    ...item.evidence_refs
  ]);
}

function guardianCorrelations(alert: PiGuardianAlert): string[] {
  return compact([
    alert.run_group_id ? `run_group:${alert.run_group_id}` : "",
    alert.issue_id > 0 ? `issue:${alert.issue_id}` : "",
    alert.project_id ? `project:${alert.project_id}` : ""
  ]);
}

function approvalCorrelations(request: PiApprovalRequest): string[] {
  return compact([
    `approval:${request.approval_id}`,
    request.run_id ? `run:${request.run_id}` : "",
    request.issue_id > 0 ? `issue:${request.issue_id}` : "",
    request.project_id ? `project:${request.project_id}` : ""
  ]);
}

function projectIDFromInbox(item: AttentionInboxItemRecord): string {
  const schema = item.schema_item as Record<string, unknown>;
  const direct = clean(schema.project_id);
  if (direct) return direct;
  const hint = item.target_hints.find((candidate) => clean(candidate.project_id));
  return clean(hint?.project_id);
}

function projectOwner(projectID: string): AttentionCandidate["owner"] {
  const id = clean(projectID);
  return id ? { kind: "project", project_id: id } : { control_plane_id: "local", kind: "control_plane" };
}

function inboxNextAction(type: AttentionType): string {
  switch (type) {
    case "approval_required": return "review and decide the requested action";
    case "input_required": return "provide the requested input";
    case "verification_required": return "review the verification evidence";
    case "connection_issue": return "restore and verify the affected connection";
    case "failure": return "inspect and remediate the failure";
    default: return "remove the blocker or choose a safe next step";
  }
}

function requiredActor(type: AttentionType): string {
  if (type === "approval_required") return "approver";
  if (type === "input_required") return "user";
  if (type === "verification_required") return "reviewer";
  return "operator";
}

function sourceRef(
  authority: AttentionSourceRef["authority"],
  localID: number | string,
  sourceState: string,
  resolution: AttentionSourceRef["resolution"],
  correlationRefs: string[]
): AttentionSourceRef {
  return {
    authority,
    correlation_refs: compact(correlationRefs),
    local_id: String(localID),
    resolution,
    source_state: sourceState
  };
}

function severity(value: string): AttentionSeverity {
  const normalized = clean(value).toLowerCase();
  if (["critical", "urgent", "emergency"].includes(normalized)) return "critical";
  if (["high", "major"].includes(normalized)) return "high";
  if (["low", "minor"].includes(normalized)) return "low";
  return "medium";
}

function jsonStringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function prefixed(prefix: string, value: unknown): string {
  const normalized = clean(value);
  return normalized ? `${prefix}:${normalized}` : "";
}

function compact(values: string[]): string[] {
  return [...new Set(values.map(clean).filter(Boolean))].sort();
}

function clean(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
