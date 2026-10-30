import { expect, test } from "bun:test";

import { listPiApprovalRequests } from "../db/repositories/pi/approvalRequests.ts";
import { listPiGuardianDecisions } from "../db/repositories/pi/guardianDecisions.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";

import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";

import {
  openFixtureDatabase,
  FastApprovalAuditProvider,
  fastResolvedEvent,
  insertProject,
  insertIssue,
  failingAuditDatabase
} from "./providerApprovalRequestsTestFixtures.ts";

export function registerProviderApprovalRequestsResolutionCases() {
  test("records fast approval audit idempotently with redacted summary and hash refs only", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;

    await runIssueWithProvider(new FastApprovalAuditProvider(), {
      database: db,
      issueId,
      issueRunId,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt"
    });

    const requests = listPiApprovalRequests(db, { provider: "codex", sessionId: "thread-fast" });
    const decisions = listPiGuardianDecisions(db, {
      decisionKind: "approval",
      issueId,
      projectId: "demo"
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      approval_id: "approval-fast-1",
      approval_source: "codex_provider_fast_resolver",
      async_escalation_state: "none",
      decision: "approve",
      fast_decision: "approve",
      fast_decision_reason: "current repo read-only command",
      fast_policy_latency_ms: 7,
      fast_policy_rule: "pi_approval_allow_current_repo_read_only_once",
      request_type: "command",
      resolved_decision: "approve",
      resolved_scope: "turn",
      status: "approved"
    });
    expect(requests[0].request_summary).toContain("CODEX_API_KEY=[redacted]");
    expect(requests[0].request_summary).toContain("[redacted-path]");
    expect(requests[0].request_summary).not.toContain("fixture-secret");
    expect(requests[0].request_summary).not.toContain("/Users/example");
    expect(requests[0].raw_payload_json).toContain("sha256:");
    expect(requests[0].raw_payload_json).toContain("session_grant_reusable");
    expect(requests[0].raw_payload_json).toContain("session_grant_ttl_ms");
    expect(requests[0].raw_payload_json).not.toContain("fixture-secret");
    expect(requests[0].raw_payload_json).not.toContain("/Users/example");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "approve",
      decision_kind: "approval",
      id: "approval-fast:approval-fast-1",
      idempotency_key: `approval:demo:${issueId}:approval-fast-1`,
      state: "completed"
    });
    expect(decisions[0].evidence_json).toContain("pi_approval_requests:approval-fast-1");
    expect(decisions[0].evidence_json).toContain("sha256:");
    expect(decisions[0].evidence_json).not.toContain("fixture-secret");
    expect(decisions[0].evidence_json).not.toContain("/Users/example");
  });

  test("swallows SQLite audit failures for fast approval events", () => {
    const session = { provider: "codex" as const, sessionId: "thread-fast", turnId: "turn-fast" };

    expect(() => syncProviderApprovalRequest({
      database: failingAuditDatabase(),
      issueId: 1,
      projectId: "demo"
    }, fastResolvedEvent(session), "issue-1-attempt-1")).not.toThrow();
  });
}
