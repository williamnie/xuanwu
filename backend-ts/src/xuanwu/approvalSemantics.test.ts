import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiActionByIdempotencyKey } from "../db/repositories/pi.ts";
import { executeSafePiAction } from "../pi/actionEngine.ts";
import { gatePiActionEnvelope, type PiActionEnvelope } from "../pi/actionGate.ts";
import { constrainApprovalGrantScope } from "../pi/approvalGrantScope.ts";
import {
  APPROVAL_MIGRATION_CONTRACT,
  APPROVAL_PERMISSION_MATRIX,
  APPROVAL_SCOPE_CONTRACT,
  approvalScopeContract
} from "./approvalSemantics.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { force: true, recursive: true });
});

describe("Xuanwu Approval semantics", () => {
  test("locks the current authorities, scope support, TTL, and permission matrix", () => {
    expect(APPROVAL_SCOPE_CONTRACT.map((item) => item.id)).toEqual(["once", "session", "project"]);
    expect(approvalScopeContract("once")).toMatchObject({ current_support: "active" });
    expect(approvalScopeContract("session")).toMatchObject({ current_support: "disabled", current_ttl: expect.stringContaining("0 ms") });
    expect(approvalScopeContract("project")).toMatchObject({ current_support: "policy_only" });
    expect(() => approvalScopeContract("tenant" as never)).toThrow("unsupported Approval scope");

    expect(APPROVAL_PERMISSION_MATRIX).toContainEqual(expect.objectContaining({
      action_family: "git push / PR / deploy / external write", gate: "ask", target_scopes: ["once"]
    }));
    expect(APPROVAL_PERMISSION_MATRIX).toContainEqual(expect.objectContaining({
      action_family: "destructive command / force push / privilege or secret access", gate: "deny", target_scopes: ["once"]
    }));
    expect(APPROVAL_MIGRATION_CONTRACT.current_authorities).toContain("pi_approval_requests");
    expect(APPROVAL_MIGRATION_CONTRACT.current_authorities).toContain("pi_actions");
    expect(APPROVAL_MIGRATION_CONTRACT.current_window).toContain("no dual write");
  });

  test("expires authorization and does not let LLM-provided policy bypass a high-risk gate", () => {
    const highRisk = envelope("session.steer", "high", true);
    expect(gatePiActionEnvelope(highRisk, {
      allowed_actions: ["session.steer"],
      authorizedActions: [{ action_type: "session.steer", project_id: "demo" }],
      mode: "autonomous",
      now: "2026-07-17T01:00:00.000Z",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "ask" });
    expect(gatePiActionEnvelope(envelope("issue.comment", "low", false), {
      allowed_actions: ["issue.comment"],
      expires_at: "2026-07-17T00:59:59.999Z",
      mode: "delegated",
      now: "2026-07-17T01:00:00.000Z",
      scope: { project_id: "demo" }
    })).toMatchObject({ decision: "deny", reason: expect.stringContaining("expired") });
  });

  test("downgrades provider session approval and replays a resume binding idempotently", async () => {
    expect(constrainApprovalGrantScope({ decision: "approve_session", scope: "session" }, {
      provider: "codex", requestType: "command", sessionId: "session-714"
    })).toMatchObject({
      audit: { effective_scope: "turn", session_grant_ttl_ms: 0, session_grant_reusable: false },
      decision: { decision: "approve", scope: "turn" }
    });

    const db = await openFixtureDatabase();
    let dispatches = 0;
    const input = {
      actionType: "issue.comment",
      authorization: { mode: "attended", scope: { project_id: "demo" } } as const,
      idempotencyKey: "approval-resume:714",
      issueID: 714,
      payload: { body: "resume" },
      projectID: "demo",
      execute: () => ({ dispatch: ++dispatches })
    };
    const first = executeSafePiAction(db, { source: "approval-contract-test" }, input);
    const second = executeSafePiAction(db, { source: "approval-contract-test" }, input);

    expect(first).toMatchObject({ dispatch: 1 });
    expect(second).toMatchObject({ action_id: expect.any(String), result: { dispatch: 1 }, status: "completed" });
    expect(dispatches).toBe(1);
    const action = getPiActionByIdempotencyKey(db, "approval-resume:714");
    expect(action).toMatchObject({ idempotency_key: "approval-resume:714", status: "completed" });
  });

  test("keeps the ADR's source-of-truth, rollback, and deletion gates reviewable", async () => {
    const path = resolve(import.meta.dir, "../../../docs/architecture/xuanwu/0063-approval-action-gate.md");
    const adr = await Bun.file(path).text();
    for (const term of ["source of truth", "双写为 0", "resume token", "回滚", "最终删除门禁", "LLM"]) {
      expect(adr).toContain(term);
    }
  });
});

function envelope(actionType: string, riskLevel: "low" | "medium" | "high", requiresConfirmation: boolean): PiActionEnvelope {
  return {
    action_type: actionType,
    issue_id: 714,
    payload: {},
    project_id: "demo",
    requires_confirmation: requiresConfirmation,
    risk_level: riskLevel,
    source: "llm-output"
  };
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-approval-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: root });
}
