import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getPiApprovalRequest, upsertPiApprovalRequest } from "../db/repositories/pi.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI approval requests API", () => {
  test("lists open provider approvals and resolves Codex approval once from the panel", async () => {
    const db = await fixtureDatabase();
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    try {
      createApprovalRequest(db, "approval-panel-1");
      const router = createDefaultRouter({ database: db, providers: { codex: approvalProvider(resolutions) } });

      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/approval-requests?status=open`));
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

      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual([expect.objectContaining({ approval_id: "approval-panel-1" })]);
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({ ok: true, status: "approved" });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ok: true, status: "approved" });
      expect(resolutions).toEqual([{ decision: "approve", id: "approval-panel-1", scope: "turn" }]);
      expect(getPiApprovalRequest(db, "approval-panel-1")).toMatchObject({ status: "approved" });
    } finally {
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

function approvalProvider(resolutions: Array<{ decision: string; id: string; scope: string }>): ExecutorProvider {
  return {
    capabilities: ["approvals"],
    id: "codex",
    async run(_input: ProviderRunInput): Promise<never> {
      throw new Error("not implemented");
    },
    async resolveApproval(id, decision) {
      resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" });
    }
  };
}
