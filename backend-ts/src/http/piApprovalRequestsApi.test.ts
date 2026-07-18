import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest, upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI approval requests API", () => {
  test("lists approval detail and handles approve/deny exactly once from Command Center", async () => {
    const db = await fixtureDatabase();
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    const bus = new EventBus();
    const events: string[] = [];
    const stop = bus.observe(event => events.push(event.type));
    try {
      createApprovalRequest(db, "approval-panel-1");
      createApprovalRequest(db, "approval-panel-deny");
      const router = createDefaultRouter({ bus, database: db, providers: { codex: approvalProvider(resolutions) } });

      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests?status=open`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-1`));
      const resolved = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-1/resolve`, {
        body: JSON.stringify({ decision: "approve", scope: "turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const duplicate = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-1/resolve`, {
        body: JSON.stringify({ decision: "deny", scope: "turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const denied = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-deny/resolve`, {
        body: JSON.stringify({ decision: "deny", scope: "turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));

      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ approval_id: "approval-panel-1" }),
        expect.objectContaining({ approval_id: "approval-panel-deny" })
      ]));
      expect(await detail.json()).toMatchObject({ approval_id: "approval-panel-1", status: "delivered" });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ ok: true, status: "approved" });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ok: true, status: "approved" });
      expect(await denied.json()).toMatchObject({ ok: true, status: "rejected" });
      expect(resolutions).toEqual([
        { decision: "approve", id: "approval-panel-1", scope: "turn" },
        { decision: "deny", id: "approval-panel-deny", scope: "turn" }
      ]);
      expect(getPiApprovalRequest(db, "approval-panel-1")).toMatchObject({ status: "approved" });
      expect(getPiApprovalRequest(db, "approval-panel-deny")).toMatchObject({ status: "rejected" });
      expect(events).toContain("approval.resolved");
    } finally {
      stop();
      db.close();
    }
  });

  test("filters approval request list by provider session and run", async () => {
    const db = await fixtureDatabase();
    try {
      createApprovalRequest(db, "approval-panel-2", {
        runID: "issue-393-attempt-1",
        sessionID: "thread-393"
      });
      createApprovalRequest(db, "approval-panel-3", {
        runID: "issue-394-attempt-1",
        sessionID: "thread-394"
      });
      const router = createDefaultRouter({ database: db });

      const response = await router.handle(new Request(
        `${BASE_URL}/api/pi/approval-requests?provider=codex&session_id=thread-393&run_id=issue-393-attempt-1`
      ));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([expect.objectContaining({
        approval_id: "approval-panel-2",
        run_id: "issue-393-attempt-1",
        session_id: "thread-393"
      })]);
    } finally {
      db.close();
    }
  });

  test("keeps failed resolver decisions visible and retryable from the panel", async () => {
    const db = await fixtureDatabase();
    let failNext = true;
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    try {
      createApprovalRequest(db, "approval-panel-fail");
      const router = createDefaultRouter({
        database: db,
        providers: {
          codex: approvalProvider(resolutions, async () => {
            if (!failNext) return;
            failNext = false;
            throw new Error("approval request is not pending: approval-panel-fail");
          })
        }
      });

      const failed = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-fail/resolve`, {
        body: JSON.stringify({ decision: "approve", scope: "turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));
      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests?status=open`));
      const retried = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests/approval-panel-fail/resolve`, {
        body: JSON.stringify({ decision: "approve", scope: "turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      }));

      expect(failed.status).toBe(409);
      expect(await failed.json()).toEqual({ message: "approval request is not pending: approval-panel-fail" });
      expect(await listed.json()).toEqual([expect.objectContaining({
        approval_id: "approval-panel-fail",
        resolver_error: expect.stringContaining("approval request is not pending"),
        resolver_retryable: 1,
        resolver_status: "failed",
        status: "resolve_failed"
      })]);
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ ok: true, status: "approved" });
      expect(resolutions).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-approval-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function createApprovalRequest(
  db: RunnerDatabase,
  approvalID: string,
  options: { runID?: string; sessionID?: string } = {}
): void {
  upsertPiApprovalRequest(db, {
    approval_id: approvalID,
    approval_source: "codex_provider_event",
    issue_id: 392,
    project_id: "demo",
    provider: "codex",
    provider_approval_id: approvalID,
    request_summary: "command=git status",
    request_type: "command",
    run_id: options.runID,
    session_id: options.sessionID,
    status: "delivered",
    thread_id: options.sessionID ?? "thread-panel"
  });
}

function approvalProvider(
  resolutions: Array<{ decision: string; id: string; scope: string }>,
  onResolve?: () => Promise<void>
): ExecutorProvider {
  return {
    capabilities: ["approvals"],
    id: "codex",
    async run(_input: ProviderRunInput): Promise<never> {
      throw new Error("not implemented");
    },
    async resolveApproval(id, decision) {
      resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" });
      await onResolve?.();
    }
  };
}
