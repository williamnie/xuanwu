import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAction, getPiAction, listPiActionEvents, listPiMcpApprovalGrants } from "../db/repositories/pi.ts";
import { upsertPiMcpCapability } from "../db/repositories/piMcpCapabilities.ts";
import { patchPiMcpServer, upsertPiMcpServer, type PiMcpApprovalMode } from "../db/repositories/piMcpServers.ts";
import { getProject } from "../db/repositories/projects.ts";
import { resolvePiActionDecision } from "../http/piActionDecision.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { expirePendingMcpApprovals } from "../pi/mcpApprovalExpiry.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("MCP approval policy", () => {
  test("auto-runs ordinary writes, asks for every-write, and denies writes in read-only mode", async () => {
    const { db, project } = await fixture("medium");
    try {
      expect(call(db, project)).toMatchObject({ status: "failed" });
      expect(latest(db)).toMatchObject({ gate_decision: "execute", status: "completed" });

      patchPiMcpServer(db, "fixture", { approval_mode: "every_write" });
      expect(call(db, project)).toMatchObject({ decision: "ask", status: "pending" });
      expect(latest(db)).toMatchObject({ gate_decision: "ask", status: "pending" });

      patchPiMcpServer(db, "fixture", { approval_mode: "read_only" });
      expect(call(db, project)).toMatchObject({ decision: "deny", status: "denied" });
      expect(latest(db)).toMatchObject({ gate_decision: "deny", status: "denied" });
    } finally { db.close(); }
  });

  test("approve-always creates an exact project capability grant and executes the pending call", async () => {
    const { db, project } = await fixture("high");
    try {
      const pending = call(db, project) as { action_id: string; status: string };
      expect(pending.status).toBe("pending");

      const completed = await resolvePiActionDecision({ database: db }, {
        actionID: pending.action_id,
        actor: "test:user",
        decision: "approve_always"
      });

      expect(completed.status).toBe("completed");
      expect(listPiMcpApprovalGrants(db, { projectID: project.id })).toEqual([
        expect.objectContaining({ capability_id: "fixture:tool:write", granted_by: "test:user", revoked_at: "" })
      ]);
      expect(call(db, project)).toMatchObject({ status: "failed" });
      expect(latest(db)).toMatchObject({ gate_decision: "execute", status: "completed" });

      patchPiMcpServer(db, "fixture", { command: "/changed/mcp/server" });
      expect(call(db, project)).toMatchObject({ decision: "ask", status: "pending" });
      expect(latest(db)).toMatchObject({ gate_decision: "ask", status: "pending" });
    } finally { db.close(); }
  });

  test("expires stale pending MCP approvals and records the reason", async () => {
    const { db } = await fixture("high");
    try {
      createPiAction(db, {
        action_type: "mcp.tool.call",
        gate_decision: "ask",
        id: "expired-mcp-approval",
        lease_expires_at: "2026-01-02T00:00:00.000Z",
        project_id: "demo",
        status: "pending"
      });
      expect(expirePendingMcpApprovals(db, new Date("2026-01-03T00:00:00.000Z"))).toBe(1);
      expect(getPiAction(db, "expired-mcp-approval")).toMatchObject({ decided_by: "system:approval_ttl", status: "rejected" });
      expect(listPiActionEvents(db, { actionId: "expired-mcp-approval" }).map((event) => event.event_type))
        .toContain("approval_expired");
    } finally { db.close(); }
  });
});

async function fixture(risk: "medium" | "high", mode: PiMcpApprovalMode = "dangerous_only") {
  const root = await mkdtemp(join(tmpdir(), "mcp-approval-policy-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", "/tmp/demo", "codex", "{}", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  upsertPiMcpServer(db, {
    approval_mode: mode,
    enabled: true,
    id: "fixture",
    name: "Fixture",
    readiness: "ready",
    status: "available"
  });
  upsertPiMcpCapability(db, {
    enabled: true,
    id: "fixture:tool:write",
    kind: "tool",
    name: "write",
    permission: "write",
    read_only: false,
    requires_confirmation: risk === "high",
    risk_level: risk,
    server_id: "fixture"
  });
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing project");
  return { db, project };
}

function call(db: RunnerDatabase, project: NonNullable<ReturnType<typeof getProject>>) {
  return createPiRunnerActions(db, {
    authorization: {
      allowedMcpCapabilities: ["fixture:tool:write"],
      authorizedActions: [{ action_type: "mcp.tool.call", project_id: project.id }],
      mode: "delegated",
      scope: { project_id: project.id }
    },
    project
  }).callMcpTool({ capability_id: "fixture:tool:write", input: { value: 1 } });
}

function latest(db: RunnerDatabase) {
  return db.sqlite.query<Record<string, unknown>, []>("select * from pi_actions order by rowid desc limit 1").get();
}
