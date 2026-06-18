import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest, listPiApprovalRequests } from "../db/repositories/pi/approvalRequests.ts";
import { listPiGuardianDecisions } from "../db/repositories/pi/guardianDecisions.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput, SessionRef } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";

const tempRoots: string[] = [];

class ApprovalEventProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  constructor(private readonly options: { resolve?: boolean } = {}) {}

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-approval", turnId: "turn-approval" };
    const requested: ProviderEvent = approvalRequestedEvent(session);
    input.onEvent?.(requested);
    input.onEvent?.(requested);
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session,
      text: "ordinary command output says approval denied"
    });
    if (this.options.resolve) input.onEvent?.(approvalResolvedEvent(session));
    return { runId: "codex-run", session };
  }
}

class TextOnlyProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-text", turnId: "turn-text" };
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session,
      text: "ordinary command output says approval denied"
    });
    return { runId: "codex-run", session };
  }
}

class FastApprovalAuditProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution"] as const;

  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-fast", turnId: "turn-fast" };
    const event = fastResolvedEvent(session);
    input.onEvent?.(event);
    input.onEvent?.(event);
    return { runId: "codex-run", session };
  }
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("provider runtime approval request sync", () => {
  test("creates one pending request from repeated structured approval requested events only", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new ApprovalEventProvider(), {
        database: db,
        issueId,
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
      expect(requests[0].raw_payload_json).not.toContain("fixture-secret");
      expect(requests[0].raw_payload_json).not.toContain("/Users/example");
      expect(getPiApprovalRequest(db, "ordinary command output says approval denied")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("syncs structured approval resolved events to terminal status", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new ApprovalEventProvider({ resolve: true }), {
        database: db,
        issueId,
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
    } finally {
      db.close();
    }
  });

  test("ignores approval words in ordinary provider output", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new TextOnlyProvider(), {
        database: db,
        issueId,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      });

      expect(listPiApprovalRequests(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("records fast approval audit idempotently with redacted summary and hash refs only", async () => {
    const db = await openFixtureDatabase();
    try {
      insertProject(db, "demo");
      const issueId = insertIssue(db, "demo");

      await runIssueWithProvider(new FastApprovalAuditProvider(), {
        database: db,
        issueId,
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
      expect(requests[0].raw_payload_json).toContain("sha256:");
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
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-provider-approval-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function approvalRequestedEvent(session: SessionRef): ProviderEvent {
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "pending",
    raw: {
      method: "approval/requested",
      payload: JSON.stringify({
        id: "approval-runtime-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
          itemId: "approval-runtime-1",
          threadId: "thread-approval",
          turnId: "turn-approval"
        }
      })
    }
  };
}

function approvalResolvedEvent(session: SessionRef): ProviderEvent {
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "cancel",
    raw: {
      method: "approval/resolved",
      payload: JSON.stringify({ decision: "cancel", id: "approval-runtime-1", scope: "turn" })
    }
  };
}

function fastResolvedEvent(session: SessionRef): ProviderEvent {
  const payload = {
    decision: "approve",
    fast_decision: "approve-now",
    id: "approval-fast-1",
    latency_ms: 7,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-fast", turnId: "turn-fast" },
    reason: "current repo read-only command",
    request_summary: "command=cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
    request_type: "command",
    rule_id: "pi_approval_allow_current_repo_read_only_once",
    scope: "turn"
  };
  return {
    provider: "codex",
    type: "approval",
    session,
    status: "approve",
    payload,
    raw: {
      method: "approval/fast_resolved",
      payload: JSON.stringify(payload)
    }
  };
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Runtime", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
