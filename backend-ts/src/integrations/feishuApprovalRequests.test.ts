import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest, upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import { resolvePiApprovalRequestFromFeishu } from "./feishuApprovalRequests.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("Feishu approval request resolver", () => {
  test("calls fake Codex resolver with provider approval id for approve and reject", async () => {
    const db = await fixtureDatabase();
    const resolutions: Resolution[] = [];
    try {
      createRequest(db, "approval-once", "provider-once");
      createRequest(db, "approval-reject", "provider-reject");
      const provider = fakeCodexResolver(resolutions);

      await resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve",
        provider,
        requestID: "approval-once",
        scope: "turn"
      });
      await resolvePiApprovalRequestFromFeishu(db, {
        decision: "deny",
        provider,
        requestID: "approval-reject",
        scope: "turn"
      });

      expect(resolutions).toEqual([
        { decision: "approve", id: "provider-once", scope: "turn" },
        { decision: "deny", id: "provider-reject", scope: "turn" }
      ]);
      expect(getPiApprovalRequest(db, "approval-once")).toMatchObject({
        resolver_attempt_count: 1,
        resolver_error: "",
        resolver_retryable: 0,
        resolver_status: "succeeded",
        resolved_decision: "approve",
        status: "approved"
      });
      expect(getPiApprovalRequest(db, "approval-reject")).toMatchObject({
        resolver_attempt_count: 1,
        resolver_status: "succeeded",
        resolved_decision: "deny",
        status: "rejected"
      });
    } finally {
      db.close();
    }
  });

  test("downgrades approve-for-session to a current-turn provider approval when scope is not proven narrow", async () => {
    const db = await fixtureDatabase();
    const resolutions: Resolution[] = [];
    try {
      createRequest(db, "approval-session", "provider-session");

      await resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve_session",
        provider: fakeCodexResolver(resolutions),
        requestID: "approval-session",
        scope: "session"
      });

      expect(resolutions).toEqual([
        { decision: "approve", id: "provider-session", scope: "turn" }
      ]);
      expect(getPiApprovalRequest(db, "approval-session")).toMatchObject({
        resolved_decision: "approve",
        resolved_scope: "turn",
        status: "approved"
      });
    } finally {
      db.close();
    }
  });

  test("keeps failed resolver decisions retryable without terminal resolve", async () => {
    const db = await fixtureDatabase();
    const resolutions: Resolution[] = [];
    try {
      createRequest(db, "approval-fail", "provider-fail");
      const provider = fakeCodexResolver(resolutions, async () => {
        if (resolutions.length === 1) throw new Error("approval request is not pending: provider-fail");
      });

      await expect(resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve",
        provider,
        requestID: "approval-fail",
        scope: "turn"
      })).rejects.toThrow("approval request is not pending");

      expect(getPiApprovalRequest(db, "approval-fail")).toMatchObject({
        decision: "approve",
        resolver_attempt_count: 1,
        resolver_error: expect.stringContaining("approval request is not pending"),
        resolver_retryable: 1,
        resolver_status: "failed",
        resolved_decision: "",
        status: "resolve_failed"
      });

      await expect(resolvePiApprovalRequestFromFeishu(db, {
        decision: "approve",
        provider,
        requestID: "approval-fail",
        scope: "turn"
      })).resolves.toMatchObject({ ok: true, status: "approved" });
      expect(getPiApprovalRequest(db, "approval-fail")).toMatchObject({
        resolver_attempt_count: 2,
        resolver_error: "",
        resolver_retryable: 0,
        resolver_status: "succeeded",
        resolved_decision: "approve",
        status: "approved"
      });
    } finally {
      db.close();
    }
  });

  test("records provider unavailable as retryable resolver failure", async () => {
    const db = await fixtureDatabase();
    try {
      createRequest(db, "approval-no-provider", "provider-no-provider");

      await expect(resolvePiApprovalRequestFromFeishu(db, {
        decision: "deny",
        requestID: "approval-no-provider",
        scope: "turn"
      })).rejects.toThrow("codex provider approval resolver is not available");

      expect(getPiApprovalRequest(db, "approval-no-provider")).toMatchObject({
        decision: "deny",
        resolver_error: "codex provider approval resolver is not available",
        resolver_retryable: 1,
        resolver_status: "failed",
        resolved_decision: "",
        status: "resolve_failed"
      });
    } finally {
      db.close();
    }
  });
});

type Resolution = { decision: string; id: string; scope: string };

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-approval-resolve-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createRequest(db: RunnerDatabase, approvalID: string, providerApprovalID: string): void {
  upsertPiApprovalRequest(db, {
    approval_id: approvalID,
    approval_source: "codex_provider_event",
    issue_id: 396,
    project_id: "demo",
    provider: "codex",
    provider_approval_id: providerApprovalID,
    request_summary: "command=git status",
    request_type: "command",
    status: "delivered",
    thread_id: "thread-approval"
  });
}

function fakeCodexResolver(resolutions: Resolution[], onResolve?: () => Promise<void>) {
  return {
    async resolveApproval(id: string, decision: { decision: string; scope?: string }) {
      resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" });
      await onResolve?.();
    }
  };
}
