import { expect, test } from "bun:test";

import { getPiApprovalRequest, listPiApprovalRequests } from "../db/repositories/pi/approvalRequests.ts";

import { createIssueRun } from "../db/repositories/issueRuns.ts";
import type { ProviderEvent } from "../providers/types.ts";
import { syncProviderApprovalRequest } from "./providerApprovalRequests.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";

import {
  openFixtureDatabase,
  ApprovalEventProvider,
  TextOnlyProvider,
  insertProject,
  insertIssue
} from "./providerApprovalRequestsTestFixtures.ts";

export function registerProviderApprovalRequestsApprovalCases() {
  test("creates one pending request from repeated structured approval requested events only", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;

    await runIssueWithProvider(new ApprovalEventProvider(), {
      database: db,
      issueId,
      issueRunId,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt"
    });

    const requests = listPiApprovalRequests(db, { provider: "codex", sessionId: "thread-approval" });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      approval_id: "approval-runtime-1",
      approval_source: "codex_provider_event",
      issue_id: issueId,
      project_id: "demo",
      provider_approval_id: "approval-runtime-1",
      request_type: "command",
      run_id: `issue-${issueId}-attempt-1`,
      status: "pending",
      thread_id: "thread-approval",
      turn_id: "turn-approval"
    });
    expect(requests[0].request_summary).toContain("command=cat CODEX_API_KEY=[redacted]");
    expect(requests[0].request_summary).toContain("[redacted-path]");
    expect(requests[0].request_summary).not.toContain("fixture-secret");
    expect(requests[0].request_summary).not.toContain("/Users/example");
    expect(requests[0].raw_payload_json).not.toContain("fixture-secret");
    expect(requests[0].raw_payload_json).not.toContain("/Users/example");
    expect(getPiApprovalRequest(db, "ordinary command output says approval denied")).toBeNull();
  });

  test("syncs structured approval resolved events to terminal status", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;

    await runIssueWithProvider(new ApprovalEventProvider({ resolve: true }), {
      database: db,
      issueId,
      issueRunId,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt"
    });

    expect(getPiApprovalRequest(db, "approval-runtime-1")).toMatchObject({
      approval_id: "approval-runtime-1",
      resolved_decision: "cancel",
      resolved_scope: "turn",
      status: "cancelled"
    });
  });

  test("Qoder approval events use the same durable carrier with redacted summaries", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;
    const event: ProviderEvent = {
      provider: "qoder",
      type: "approval",
      status: "pending",
      session: { provider: "qoder", sessionId: "qoder-session" },
      raw: { method: "approval/requested" },
      payload: {
        id: "qoder-session:tool-1",
        method: "qoder/canUseTool",
        params: { path: "<workspace>/src/app.ts", threadId: "qoder-session", tool_name: "Edit" }
      }
    };

    syncProviderApprovalRequest({ database: db, issueId, projectId: "demo" }, event, "issue-run-qoder");
    expect(getPiApprovalRequest(db, "qoder-session:tool-1")).toMatchObject({
      approval_source: "qoder_provider_event",
      provider: "qoder",
      request_type: "file",
      run_id: "issue-run-qoder",
      status: "pending"
    });
    syncProviderApprovalRequest({ database: db, issueId, projectId: "demo" }, {
      ...event,
      status: "approve",
      raw: { method: "approval/resolved" },
      payload: { decision: "approve", id: "qoder-session:tool-1", scope: "turn" }
    }, "issue-run-qoder");
    expect(getPiApprovalRequest(db, "qoder-session:tool-1")).toMatchObject({
      resolved_decision: "approve",
      resolved_scope: "turn",
      status: "approved"
    });
  });

  test.each([
    { provider: "claude" as const, id: "claude-inv:tool-1", method: "claude/canUseTool" },
    { provider: "pi-coding-agent" as const, id: "pi-inv:ui-1", method: "pi/extension-ui-confirm" }
  ])("$provider approval events persist callback identity and resolve through the shared carrier", async ({ provider, id, method }) => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const session = { provider, sessionId: `${provider}-session` };
    const payload = {
      id,
      method,
      params: {
        callback_owner_ref: `${provider}-inv`,
        invocation_ref: `${provider}-inv`,
        policy_revision: "xw.resolved-execution-policy.v1",
        threadId: session.sessionId,
        tool_name: "Write",
        tool_use_id: "tool-1"
      }
    };
    syncProviderApprovalRequest({ database: db, issueId, projectId: "demo" }, {
      payload,
      provider,
      raw: { method: "approval/requested", payload },
      session,
      status: "pending",
      type: "approval"
    }, `issue-run-${provider}`);

    const stored = getPiApprovalRequest(db, id);
    expect(stored).toMatchObject({ provider, provider_approval_id: id, status: "pending" });
    expect(JSON.parse(stored?.raw_payload_json ?? "{}")).toMatchObject({
      params: {
        callback_owner_ref: `${provider}-inv`,
        invocation_ref: `${provider}-inv`,
        policy_revision: "xw.resolved-execution-policy.v1"
      }
    });

    syncProviderApprovalRequest({ database: db, issueId, projectId: "demo" }, {
      payload: { decision: "deny", id, scope: "turn" },
      provider,
      raw: { method: "approval/resolved" },
      session,
      status: "deny",
      type: "approval"
    }, `issue-run-${provider}`);
    expect(getPiApprovalRequest(db, id)).toMatchObject({ resolved_decision: "deny", status: "rejected" });
  });

  test("ignores approval words in ordinary provider output", async () => {
    const db = await openFixtureDatabase();
    insertProject(db, "demo");
    const issueId = insertIssue(db, "demo");
    const issueRunId = createIssueRun(db, issueId).id;

    await runIssueWithProvider(new TextOnlyProvider(), {
      database: db,
      issueId,
      issueRunId,
      projectId: "demo",
      cwd: "/tmp/project",
      prompt: "issue prompt"
    });

    expect(listPiApprovalRequests(db)).toHaveLength(0);
  });
}
