import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AttentionInboxItemRecord } from "../../db/repositories/intakeRuns.ts";
import type { PiApprovalRequest } from "../../db/repositories/pi/approvalRequests.ts";
import type { PiAction } from "../../db/repositories/pi/actions.ts";
import type { PiGuardianAlert } from "../../db/repositories/pi/guardianAlerts.ts";
import {
  ATTENTION_PRIORITY_TABLE,
  applyAttentionCommand,
  attentionDedupeKey,
  attentionPriority,
  consolidateAttentionCandidates,
  escalateAttentionIfDue,
  reconcileAttentionSources,
  validateAttentionRecord,
  type AttentionCandidate,
  type AttentionRecord,
  type AttentionSourceRef,
  type AttentionTransitionAudit
} from "./contracts.ts";
import {
  attentionFromApprovalRequest,
  attentionFromGuardianAlert,
  attentionFromInboxItem,
  attentionFromPiAction
} from "./legacyAdapters.ts";

const CREATED = "2026-07-17T00:00:00.000Z";

describe("unified Attention contracts", () => {
  test("locks the complete priority table and deterministic escalation", () => {
    expect(ATTENTION_PRIORITY_TABLE).toEqual({
      blocker: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
      failure: { critical: "p0", high: "p1", medium: "p1", low: "p2" },
      approval_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
      input_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
      verification_required: { critical: "p0", high: "p1", medium: "p2", low: "p3" },
      connection_issue: { critical: "p0", high: "p1", medium: "p1", low: "p2" }
    });
    expect(attentionPriority("approval_required", "low", 1)).toBe("p2");
    expect(attentionPriority("approval_required", "low", 3)).toBe("p0");
    expect(() => attentionPriority("failure", "high", -1)).toThrow("non-negative integer");
  });

  test("dedupes different carriers only when actionable type, scope, and strongest correlation match", () => {
    const inbox = candidate({
      source_ref: source("attention_inbox_items", "71", "issue:713")
    });
    const guardian = candidate({
      source_ref: source("pi_guardian_alerts", "guardian-713", "issue:713")
    });
    const separateApproval = candidate({
      source_ref: source("pi_approval_requests", "approval-713", "issue:713"),
      type: "approval_required"
    });

    expect(attentionDedupeKey(inbox)).toBe(attentionDedupeKey(guardian));
    const records = consolidateAttentionCandidates([guardian, separateApproval, inbox]);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.type === "failure")?.source_refs.map((ref) => ref.authority)).toEqual([
      "attention_inbox_items",
      "pi_guardian_alerts"
    ]);

    const projectOnlyInbox = candidate({ source_ref: source("attention_inbox_items", "72", "project:xuanwu") });
    const projectOnlyGuardian = candidate({ source_ref: source("pi_guardian_alerts", "guardian-714", "project:xuanwu") });
    expect(attentionDedupeKey(projectOnlyInbox)).not.toBe(attentionDedupeKey(projectOnlyGuardian));
  });

  test("projects legacy inbox, Guardian, provider Approval, and internal Action carriers without changing their authorities", () => {
    const inbox = attentionFromInboxItem(inboxItem());
    const guardian = attentionFromGuardianAlert(guardianAlert());
    const approval = attentionFromApprovalRequest(approvalRequest());
    const action = attentionFromPiAction(piAction(), ["proposal:proposal-713"]);

    expect(inbox).toMatchObject({
      owner: { kind: "project", project_id: "xuanwu" },
      source_ref: { authority: "attention_inbox_items", resolution: "active" },
      status: "open",
      type: "failure"
    });
    expect(guardian).toMatchObject({
      source_ref: { authority: "pi_guardian_alerts", correlation_refs: ["issue:713", "project:xuanwu"] },
      type: "connection_issue"
    });
    expect(approval).toMatchObject({
      required_actor: "approver",
      source_ref: { authority: "pi_approval_requests", resolution: "active" },
      status: "waiting",
      type: "approval_required"
    });
    expect(attentionFromApprovalRequest({ ...approvalRequest(), status: "resolve_failed" })).toMatchObject({
      source_ref: { resolution: "active" },
      status: "open"
    });
    expect(action).toMatchObject({
      related_refs: expect.arrayContaining(["proposal:proposal-713", "issue:713"]),
      required_actor: "approver",
      source_ref: { authority: "pi_actions", resolution: "active" },
      status: "waiting",
      type: "approval_required"
    });
  });

  test("requires an audited allow gate for acknowledge, snooze, resolve, and escalation", () => {
    const record = projected();
    const acknowledged = applyAttentionCommand(record, {
      action: "acknowledge",
      audit: audit("2026-07-17T00:01:00.000Z"),
      expected_revision: 0
    });
    expect(acknowledged.attention).toMatchObject({ revision: 1, status: "acknowledged" });
    expect(acknowledged.audit_event).toMatchObject({
      after_status: "acknowledged",
      before_status: "open",
      operation: "acknowledge"
    });

    const snoozed = applyAttentionCommand(acknowledged.attention, {
      action: "snooze",
      audit: audit("2026-07-17T00:02:00.000Z"),
      expected_revision: 1,
      snoozed_until: "2026-07-17T02:00:00.000Z"
    });
    expect(snoozed.attention).toMatchObject({ status: "waiting", snoozed_until: "2026-07-17T02:00:00.000Z" });
    expect(escalateAttentionIfDue(snoozed.attention, audit("2026-07-17T01:00:00.000Z"))).toBeNull();

    expect(() => applyAttentionCommand(record, {
      action: "resolve",
      audit: { ...audit("2026-07-17T00:03:00.000Z"), gate: { ...audit().gate, decision: "ask" } },
      expected_revision: 0
    })).toThrow("requires an allow gate");
    expect(() => applyAttentionCommand(record, {
      action: "resolve",
      audit: audit("2026-07-17T00:03:00.000Z"),
      expected_revision: 3
    })).toThrow("revision conflict");
    expect(() => applyAttentionCommand(record, {
      action: "escalate",
      audit: { ...audit("2026-07-17T00:03:00.000Z"), gate: { ...audit().gate, authority: "human_approval" } },
      expected_revision: 0
    })).toThrow("requires a deterministic policy gate");
  });

  test("escalates due items one level and records the deterministic audit", () => {
    const result = escalateAttentionIfDue(projected(), audit("2026-07-17T01:00:00.000Z"));
    expect(result?.attention).toMatchObject({
      escalation: { count: 1, last_escalated_at: "2026-07-17T01:00:00.000Z" },
      priority: "p0",
      revision: 1
    });
    expect(result?.audit_event.operation).toBe("escalate");
  });

  test("auto-resolves only after every deduped source object is terminal", () => {
    const record = consolidateAttentionCandidates([
      candidate({ source_ref: source("attention_inbox_items", "71", "issue:713") }),
      candidate({ source_ref: source("pi_guardian_alerts", "guardian-713", "issue:713") })
    ])[0];
    const first = reconcileAttentionSources(record, [{
      ...record.source_refs[0],
      resolution: "resolved",
      source_state: "actioned"
    }], audit("2026-07-17T00:10:00.000Z"));
    expect(first.attention.status).toBe("open");

    const second = reconcileAttentionSources(first.attention, [{
      ...first.attention.source_refs[1],
      resolution: "resolved",
      source_state: "resolved"
    }], audit("2026-07-17T00:11:00.000Z"));
    expect(second.attention).toMatchObject({ revision: 2, status: "resolved" });
    expect(second.audit_event).toMatchObject({
      after_status: "resolved",
      before_status: "open",
      operation: "source_reconciled"
    });
    expect(validateAttentionRecord(second.attention)).toEqual([]);
  });

  test("keeps source of truth, coexistence, rollback, and deletion gates explicit", () => {
    const adr = readFileSync(resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0061-unified-attention-model.md"), "utf8");
    for (const term of ["source of truth", "双写为 0", "W1 shadow", "W2 cut read", "回滚", "最终删除门禁"]) {
      expect(adr).toContain(term);
    }
  });
});

function candidate(overrides: Partial<AttentionCandidate> = {}): AttentionCandidate {
  return {
    created_at: CREATED,
    next_action: "inspect failure",
    owner: { kind: "project", project_id: "xuanwu" },
    reason_code: "runtime_failure",
    required_actor: "operator",
    severity: "medium",
    source_ref: source("attention_inbox_items", "71", "issue:713"),
    status: "open",
    summary: "Runtime failed",
    type: "failure",
    updated_at: CREATED,
    ...overrides
  };
}

function source(
  authority: AttentionSourceRef["authority"],
  localID: string,
  correlation: string
): AttentionSourceRef {
  return {
    authority,
    correlation_refs: [correlation],
    local_id: localID,
    resolution: "active",
    source_state: "open"
  };
}

function projected(): AttentionRecord {
  return consolidateAttentionCandidates([candidate()])[0];
}

function audit(occurredAt = "2026-07-17T00:01:00.000Z"): AttentionTransitionAudit {
  return {
    actor: { id: "supervisor", kind: "supervisor" },
    correlation_id: "corr-713",
    event_id: `attention-event:${occurredAt}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "attention-policy:v1" },
    occurred_at: occurredAt,
    reason: "source facts changed"
  };
}

function inboxItem(): AttentionInboxItemRecord {
  return {
    actor_refs: [], actor_refs_json: "[]", bundle_id: 1, confidence: 0.9,
    created_at: CREATED, evidence_refs: ["issue:713"], evidence_refs_json: '["issue:713"]',
    id: 71, intake_run_id: 2, kind: "attention", primary_intent: "runtime_error",
    schema_item: { issue_id: 713, project_id: "xuanwu" },
    schema_item_json: '{"issue_id":713,"project_id":"xuanwu"}',
    secondary_intents: [], secondary_intents_json: "[]", source: "fixture",
    status: "failed", suggested_actions: ["inspect"], suggested_actions_json: '["inspect"]',
    summary: "Runtime failed", target_hints: [], target_hints_json: "[]", title: "Failure",
    updated_at: CREATED, urgency: "high"
  };
}

function guardianAlert(): PiGuardianAlert {
  return {
    alert_type: "provider_connection_unavailable", created_at: CREATED, direct_feishu_error: "",
    direct_feishu_message_id: "", direct_feishu_state: "not_attempted", evidence_json: "[]",
    id: "guardian-713", issue_id: 713, max_retry_count: 3, message: "Provider unavailable",
    next_retry_at: "", project_id: "xuanwu", retry_count: 0, run_group_id: "",
    severity: "urgent", status: "open", ui_visible: 1, updated_at: CREATED, watchdog_seen_at: CREATED
  };
}

function approvalRequest(): PiApprovalRequest {
  return {
    approval_id: "approval-713", approval_source: "provider", async_escalation_state: "",
    created_at: CREATED, decision: "", delivered_at: "", delivery_channel: "", delivery_state: "pending",
    fast_decision: "", fast_decision_reason: "", fast_policy_latency_ms: 0, fast_policy_rule: "",
    issue_id: 713, project_id: "xuanwu", provider: "codex", provider_approval_id: "approval-713",
    raw_payload_json: "{}", request_summary: "Approve command", request_type: "command",
    resolver_attempt_count: 0, resolver_error: "", resolver_last_attempt_at: "", resolver_retryable: 0,
    resolver_status: "", resolved_at: "", resolved_decision: "", resolved_scope: "", risk: "medium",
    run_id: "run-713", session_id: "session-713", status: "pending", summary: "Approve command",
    thread_id: "session-713", turn_id: "turn-713", updated_at: CREATED
  };
}

function piAction(): PiAction {
  return {
    action_type: "issue.enqueue", approved_by: "", before_snapshot_json: "{}", conversation_id: "conversation-713",
    created_at: CREATED, decided_by: "", delegation_id: "", expected_state_json: "{}", gate_decision: "ask",
    gate_reason: "risk requires user confirmation", guardian_decision_id: "", heartbeat_id: "", id: "action-713",
    idempotency_key: "action-proposal:proposal-713:action-1", issue_id: 713, lease_expires_at: "", lease_key: "",
    legacy_bypass_reason: "", payload_json: '{"proposal_id":"proposal-713"}', project_id: "xuanwu",
    rationale: "Enqueue issue 713", requested_changes: "", requires_confirmation: 1, result_json: "{}",
    risk_level: "medium", snoozed_until: "", source: "action_proposal", status: "pending", updated_at: CREATED
  };
}
