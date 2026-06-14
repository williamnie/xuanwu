import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../database.ts";
import {
  createPiApprovalRequest,
  getPiApprovalRequest,
  listPiActions,
  listPiApprovalRequests,
  markPiApprovalDelivered,
  resolvePiApprovalRequestRecord,
  updatePiApprovalRequest
} from "../pi.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI executor approval request repository", () => {
  test("creates provider approval requests idempotently by provider session approval id", async () => {
    const db = await openFixtureDatabase();
    try {
      const first = createPiApprovalRequest(db, {
        approval_id: "approval-393-1",
        issue_id: 393,
        project_id: "demo",
        provider: "codex",
        request_type: "command",
        run_id: "issue-393-attempt-1",
        session_id: "thread-393",
        summary: "command=git status",
        turn_id: "turn-393"
      });
      const second = createPiApprovalRequest(db, {
        approval_id: "approval-393-1",
        issue_id: 393,
        project_id: "demo",
        provider: "codex",
        request_type: "command",
        run_id: "issue-393-attempt-1",
        session_id: "thread-393",
        summary: "command=git status --short",
        turn_id: "turn-393"
      });
      const requests = listPiApprovalRequests(db, { provider: "codex", sessionId: "thread-393" });
      const delivered = markPiApprovalDelivered(db, "approval-393-1", {
        channel: "feishu",
        timestamp: new Date("2026-06-14T01:00:00Z")
      });
      const duplicateAfterDelivery = createPiApprovalRequest(db, {
        approval_id: "approval-393-1",
        issue_id: 393,
        project_id: "demo",
        provider: "codex",
        request_type: "command",
        session_id: "thread-393",
        summary: "command=git status --short"
      });

      expect(first).toMatchObject({
        approval_id: "approval-393-1",
        delivery_state: "pending",
        request_summary: "command=git status",
        session_id: "thread-393",
        status: "pending",
        summary: "command=git status",
        thread_id: "thread-393"
      });
      expect(second).toMatchObject({
        approval_id: "approval-393-1",
        request_summary: "command=git status --short",
        run_id: "issue-393-attempt-1",
        session_id: "thread-393",
        summary: "command=git status --short"
      });
      expect(delivered).toMatchObject({ delivery_state: "delivered", status: "delivered" });
      expect(duplicateAfterDelivery).toMatchObject({ delivery_state: "delivered", status: "delivered" });
      expect(requests).toHaveLength(1);
      expect(listPiActions(db, { status: "pending" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  test("updates delivery and decision lifecycle fields without changing resolved records", async () => {
    const db = await openFixtureDatabase();
    try {
      createPiApprovalRequest(db, {
        approval_id: "approval-393-2",
        issue_id: 393,
        project_id: "demo",
        provider: "codex",
        request_type: "command",
        session_id: "thread-393",
        summary: "command=bun test"
      });

      const delivered = markPiApprovalDelivered(db, "approval-393-2", {
        channel: "feishu",
        timestamp: new Date("2026-06-14T01:00:00Z")
      });
      const updated = updatePiApprovalRequest(db, "approval-393-2", {
        delivery_state: "sent"
      });
      const resolved = resolvePiApprovalRequestRecord(db, "approval-393-2", {
        decision: "approve_session",
        scope: "session",
        timestamp: new Date("2026-06-14T01:01:00Z")
      });
      const duplicate = resolvePiApprovalRequestRecord(db, "approval-393-2", {
        decision: "deny",
        timestamp: new Date("2026-06-14T01:02:00Z")
      });

      expect(delivered).toMatchObject({
        delivered_at: "2026-06-14T01:00:00.000Z",
        delivery_channel: "feishu",
        delivery_state: "delivered",
        status: "delivered"
      });
      expect(updated).toMatchObject({ delivery_state: "sent" });
      expect(resolved).toMatchObject({
        decision: "approve_session",
        resolver_attempt_count: 0,
        resolver_status: "",
        resolved_at: "2026-06-14T01:01:00.000Z",
        resolved_decision: "approve_session",
        resolved_scope: "session",
        status: "approved"
      });
      expect(duplicate).toMatchObject({
        decision: "approve_session",
        resolved_at: "2026-06-14T01:01:00.000Z",
        status: "approved"
      });
      expect(getPiApprovalRequest(db, "approval-393-2")).toMatchObject(resolved);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-approval-repo-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}
