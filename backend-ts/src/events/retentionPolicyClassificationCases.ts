import { expect, test } from "bun:test";

import {
  DEFAULT_EVENT_RETENTION_CONFIG,
  EVENT_RETENTION_POLICY_IDS,
  classifyEventRetention,
  evaluateEventRetention,
  retentionScopeID,
  validateEventRetentionConfig,
  type EventRetentionConfig
} from "./retentionPolicy.ts";
import { eventOf, eligibleInput } from "./retentionPolicyTestFixtures.ts";

export function registerRetentionPolicyClassificationCases() {
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
      minimum_retention_days: 7,
      source_delete_after_days: 7
    });
    expect(DEFAULT_EVENT_RETENTION_CONFIG.policies.raw_durable).toMatchObject({
      archive_after_days: 30,
      archive_minimum_days: 2555,
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

  test("excludes active, failed, and pending-verification issues from archive and delete", () => {
    for (const [issueStatus, blocker] of [
      ["in_progress", "active_issue"],
      ["failed", "failed_issue"],
      ["pending_verification", "pending_verification_issue"]
    ] as const) {
      const input = eligibleInput();
      const result = evaluateEventRetention({
        ...input,
        event: { ...input.event, issue_status: issueStatus }
      });
      expect(result.blockers).toContain(blocker);
      expect(result.action).toBe("keep");
      expect(result.can_execute_delete).toBe(false);
    }
  });
}
