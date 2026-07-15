import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  ARCHIVE_RECEIPT_SCHEMA_VERSION,
  EVENT_RETENTION_POLICY_IDS,
  SUMMARY_WATERMARK_SCHEMA_VERSION,
  classifyEventRetention,
  evaluateEventRetention,
  retentionScopeID,
  validateEventRetentionConfig,
  type ArchiveReceipt,
  type DestructiveGate,
  type EventRetentionConfig,
  type RetainedEvent,
  type SummaryWatermark
} from "./retentionPolicy.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = resolve(REPO_ROOT, "docs/architecture/xuanwu/0007-event-retention-policy.md");
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

describe("event retention policy", () => {
  test("classifies raw, state, audit, and delivery records without downgrading unknown events", () => {
    expect(classifyEventRetention(eventOf("issue.log", "item/agentMessage/delta"))).toMatchObject({
      event_class: "raw_log", policy_id: "raw_operational", tier: "R1_OPERATIONAL"
    });
    expect(classifyEventRetention(eventOf("issue.log", "item/completed"))).toMatchObject({
      event_class: "raw_log", policy_id: "raw_durable", tier: "R2_DURABLE"
    });
    expect(classifyEventRetention(eventOf("issue.status_changed"))).toMatchObject({
      event_class: "state_event", policy_id: "state_event", tier: "R3_AUDIT"
    });
    expect(classifyEventRetention(eventOf("issue.log", "turn/completed"))).toMatchObject({
      event_class: "audit_event", policy_id: "audit_event", tier: "R3_AUDIT"
    });
    expect(classifyEventRetention(eventOf("issue.verification_report"))).toMatchObject({
      event_class: "delivery_evidence", policy_id: "delivery_evidence", tier: "R3_AUDIT"
    });
    expect(classifyEventRetention(eventOf("issue.future_unknown"))).toMatchObject({
      event_class: "review_required", policy_id: "review_required", tier: "REVIEW_REQUIRED"
    });
    expect(classifyEventRetention({ event_type: "sent", source: "sync_outbox" })).toMatchObject({
      event_class: "delivery_evidence", policy_id: "delivery_evidence"
    });
  });

  test("keeps the default configuration safe and internally consistent", () => {
    expect(validateEventRetentionConfig(DEFAULT_EVENT_RETENTION_CONFIG)).toEqual([]);
    expect(Object.keys(DEFAULT_EVENT_RETENTION_CONFIG.policies).sort()).toEqual([...EVENT_RETENTION_POLICY_IDS].sort());
    expect(DEFAULT_EVENT_RETENTION_CONFIG.execution_mode).toBe("report_only");
    expect(DEFAULT_EVENT_RETENTION_CONFIG.execution_authorization).toBeNull();
    expect(DEFAULT_EVENT_RETENTION_CONFIG.policies.raw_operational).toMatchObject({
      archive_after_days: 7,
      archive_minimum_days: 365,
      minimum_retention_days: 30,
      source_delete_after_days: 30
    });
    expect(DEFAULT_EVENT_RETENTION_CONFIG.policies.state_event.source_delete_after_days).toBeNull();
    expect(DEFAULT_EVENT_RETENTION_CONFIG.policies.audit_event.minimum_retention_days).toBe(2555);
    expect(DEFAULT_EVENT_RETENTION_CONFIG.policies.delivery_evidence.source_delete_after_days).toBeNull();

    const shortened: EventRetentionConfig = {
      ...DEFAULT_EVENT_RETENTION_CONFIG,
      policies: {
        ...DEFAULT_EVENT_RETENTION_CONFIG.policies,
        raw_operational: {
          ...DEFAULT_EVENT_RETENTION_CONFIG.policies.raw_operational,
          minimum_retention_days: 0,
          source_delete_after_days: 0
        }
      }
    };
    expect(validateEventRetentionConfig(shortened)).toEqual(expect.arrayContaining([
      "raw_operational.minimum_retention_days must not be shorter than the canonical default",
      "raw_operational.source_delete_after_days must not be shorter than the canonical default"
    ]));
    expect(validateEventRetentionConfig({
      ...DEFAULT_EVENT_RETENTION_CONFIG,
      execution_mode: "delete_enabled"
    })).toEqual(expect.arrayContaining([
      "non-report execution requires audited authorization",
      "delete_enabled requires observation and restore evidence"
    ]));
  });

  test("only emits a raw delete candidate after summary, archive restore, and deterministic gate checks", () => {
    const input = eligibleInput();
    const reportOnly = evaluateEventRetention(input);

    expect(reportOnly).toMatchObject({
      action: "delete_candidate",
      blockers: [],
      can_execute_delete: false,
      classification: { policy_id: "raw_operational" }
    });

    const enabled: EventRetentionConfig = {
      ...DEFAULT_EVENT_RETENTION_CONFIG,
      execution_authorization: {
        actor_id: "operator-1",
        actor_kind: "user",
        audit_event_ref: "pi_action_events:retention-enable-1",
        authorized_at: "2026-04-01T00:00:00Z",
        observation_window_ref: "retention-observation:release-1",
        policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
        reason: "focused retention verification passed",
        restore_test_ref: "archive-restore:test-1"
      },
      execution_mode: "delete_enabled"
    };
    expect(evaluateEventRetention({ ...input, config: enabled })).toMatchObject({
      action: "delete_candidate",
      blockers: [],
      can_execute_delete: true
    });
  });

  test("never deletes pinned or legal-held events, including an otherwise eligible raw record", () => {
    const input = eligibleInput();
    const eventScope = retentionScopeID(input.event, "event");
    const result = evaluateEventRetention({
      ...input,
      holds: [
        {
          actor: "operator",
          audit_event_ref: "pi_action_events:pin-1",
          created_at: "2026-02-01T00:00:00Z",
          id: "pin-1",
          kind: "pin",
          reason: "incident investigation",
          scope: "event",
          scope_id: eventScope,
          status: "active"
        },
        {
          actor: "legal",
          audit_event_ref: "pi_action_events:hold-1",
          created_at: "2026-02-01T00:00:00Z",
          id: "hold-1",
          kind: "legal_hold",
          reason: "legal preservation",
          scope: "project",
          scope_id: input.event.project_id,
          status: "active"
        }
      ]
    });

    expect(result.action).not.toBe("delete_candidate");
    expect(result.blockers).toEqual(expect.arrayContaining(["pin", "legal_hold"]));
    expect(result.can_execute_delete).toBe(false);
  });

  test("treats an unaudited legal-hold release as still active", () => {
    const input = eligibleInput();
    const result = evaluateEventRetention({
      ...input,
      holds: [{
        actor: "legal",
        audit_event_ref: "pi_action_events:hold-2",
        created_at: "2026-02-01T00:00:00Z",
        id: "hold-2",
        kind: "legal_hold",
        reason: "legal preservation",
        released_at: "2026-03-01T00:00:00Z",
        scope: "project",
        scope_id: input.event.project_id,
        status: "released"
      }]
    });

    expect(result.blockers).toContain("legal_hold");
    expect(result.action).not.toBe("delete_candidate");
  });

  test("protects active and failed run logs even when all other deletion evidence is present", () => {
    const input = eligibleInput();

    const active = evaluateEventRetention({ ...input, run: { id: "run-1", status: "in_progress" } });
    expect(active.blockers).toContain("active_run");
    expect(active.action).not.toBe("delete_candidate");

    const failed = evaluateEventRetention({ ...input, run: { id: "run-1", status: "failed" } });
    expect(failed.blockers).toContain("failed_run");
    expect(failed.action).not.toBe("delete_candidate");
  });

  test("protects handoff evidence and unresolved activity references", () => {
    const input = eligibleInput();
    const result = evaluateEventRetention({
      ...input,
      references: {
        handoff_evidence: true,
        unresolved_refs: ["pi_guardian_event_inbox:42", "pi_activity:issue_event:100"]
      }
    });

    expect(result.action).not.toBe("delete_candidate");
    expect(result.blockers).toEqual(expect.arrayContaining(["handoff_evidence", "unresolved_reference"]));
  });

  test("fails closed when summary, archive, gate, or event classification is missing", () => {
    const input = eligibleInput();
    const missing = evaluateEventRetention({
      event: input.event,
      now: input.now,
      references: { handoff_evidence: false, unresolved_refs: [] },
      run: input.run
    });
    expect(missing.blockers).toEqual(expect.arrayContaining([
      "summary_watermark_missing", "archive_receipt_missing", "destructive_gate_missing"
    ]));

    const unknown = evaluateEventRetention({
      ...input,
      event: { ...input.event, event_type: "issue.future_unknown", raw_method: "" }
    });
    expect(unknown.blockers).toEqual(expect.arrayContaining(["review_required", "source_deletion_disabled"]));
    expect(unknown.action).not.toBe("delete_candidate");
  });

  test("keeps state, audit, and delivery evidence source deletion disabled by default", () => {
    for (const event of [
      eventOf("issue.status_changed"),
      eventOf("issue.log", "turn/completed"),
      eventOf("issue.verification_reviewed")
    ]) {
      const result = evaluateEventRetention({
        ...eligibleInput(),
        event: { ...event, created_at: "2010-01-01T00:00:00Z" }
      });
      expect(result.blockers).toContain("source_deletion_disabled");
      expect(result.action).not.toBe("delete_candidate");
    }
  });

  test("keeps the canonical source-of-truth, watermark, hold, and deletion gates documented", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    for (const marker of [
      "当前 source of truth",
      "summary watermark",
      "pin",
      "legal hold",
      "failed run",
      "Handoff Evidence",
      "双写/双读期限",
      "最终删除门禁",
      "report_only"
    ]) expect(adr).toContain(marker);
  });
});

function eventOf(eventType: string, rawMethod = ""): RetainedEvent {
  return {
    created_at: "2026-01-01T00:00:00Z",
    event_type: eventType,
    id: 100,
    issue_id: 638,
    project_id: "codex-issue-runner",
    raw_method: rawMethod,
    run_id: "run-1",
    source: "issue_events"
  };
}

function eligibleInput() {
  const event = eventOf("issue.log", "item/agentMessage/delta");
  const summaryWatermark: SummaryWatermark = {
    actor_id: "retention-worker-1",
    audit_event_ref: "pi_action_events:summary-run-1-120",
    contiguous: true,
    covered_through_event_id: 120,
    issue_id: event.issue_id!,
    policy_id: "raw_operational",
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "contiguous raw log summary verified",
    run_id: event.run_id!,
    schema_version: SUMMARY_WATERMARK_SCHEMA_VERSION,
    source: event.source,
    summary_ref: "issue_events_summary:run-1:120",
    summary_sha256: SHA_A,
    verified_at: "2026-03-01T00:00:00Z",
    verifier: "deterministic_retention_worker"
  };
  const archiveReceipt: ArchiveReceipt = {
    actor_id: "retention-worker-1",
    archive_ref: "archive:issue-638:run-1:1-120",
    audit_event_ref: "pi_action_events:archive-run-1-120",
    contiguous: true,
    first_event_id: 1,
    issue_id: event.issue_id!,
    manifest_sha256: SHA_B,
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "archive checksum and restore verified",
    restored_at: "2026-03-02T00:00:00Z",
    row_count: 120,
    run_id: event.run_id!,
    schema_version: ARCHIVE_RECEIPT_SCHEMA_VERSION,
    source: event.source,
    through_event_id: 120,
    verified_at: "2026-03-01T00:00:00Z",
    verifier: "deterministic_retention_worker"
  };
  const destructiveGate: DestructiveGate = {
    actor_id: "retention-worker-1",
    actor_kind: "retention_worker",
    audit_event_ref: "pi_action_events:retention-638-1",
    decision: "allow",
    evaluated_at: "2026-04-01T00:00:00Z",
    policy_version: DEFAULT_EVENT_RETENTION_CONFIG.policy_version,
    reason: "all deterministic retention guards passed"
  };
  return {
    archive_receipt: archiveReceipt,
    destructive_gate: destructiveGate,
    event,
    now: "2026-04-01T00:00:00Z",
    references: { handoff_evidence: false, unresolved_refs: [] },
    run: { id: "run-1", status: "succeeded" },
    summary_watermark: summaryWatermark
  };
}
