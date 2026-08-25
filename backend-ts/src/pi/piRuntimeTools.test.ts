import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { HTTP_READONLY_PROVIDER_ID, URL_FETCH_TOOL_NAME } from "./httpToolProvider.ts";
import { createPiRuntimeToolKit } from "./piRuntimeTools.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI runtime tool registry adapter", () => {
  test("assembles builtin runtime tools from the current registry", async () => {
    const db = await openFixture();
    try {
      const kit = createPiRuntimeToolKit(db, undefined, {
        conversationID: "conv-capability-audit",
        source: "runner_chat"
      });
      expect(kit.source).toBe("registry");
      expect(kit.tools).toEqual(expect.arrayContaining([
        "agent_catalog_list", "capability_invoke", "capability_search", "context_status", "issue_read",
        "issue_completion_watch_create", "issue_completion_watch_list", "issue_completion_watch_cancel",
        "notification_preference_read", "notification_preference_update",
        "project_status", "session_read_summary", URL_FETCH_TOOL_NAME
      ]));
      expect(kit.tools.length).toBeLessThan(40);
      expect(kit.tools).not.toContain("issue_delete");
      const customToolNames = kit.customTools.map((tool) => tool.name).sort();
      expect(customToolNames).toEqual(expect.arrayContaining([
        "capability_invoke", "capability_search", "context_status", "issue_read", "project_status",
        URL_FETCH_TOOL_NAME
      ]));
      expect(customToolNames).not.toContain("issue_delete");
      expect(kit.audit.source).toBe("registry");
      expect(kit.audit.surface_mode).toBe("bootstrap_v2");
      expect(kit.audit.tool_names).toEqual(expect.arrayContaining([
        "read",
        URL_FETCH_TOOL_NAME,
        "issue_create_proposal",
        "issue_enqueue_proposal",
        "memory_search",
        "session_read_summary",
        "work_list"
      ]));
      expect(kit.audit.custom_tool_names).toContain(URL_FETCH_TOOL_NAME);
      expect(kit.audit.provider_ids).toEqual(expect.arrayContaining(["runner-builtin", HTTP_READONLY_PROVIDER_ID]));
      expect(kit.auditTargets.issue_status_summary).toEqual({ permission: "read", providerID: "runner-builtin" });
      expect(kit.auditTargets.issue_completion_watch_create).toEqual({ permission: "write", providerID: "runner-builtin" });
      expect(kit.readOnlyToolNames).toEqual(expect.arrayContaining([
        "agent_catalog_list", "read", "issue_list", "memory_search", "session_read_summary", "work_list", URL_FETCH_TOOL_NAME
      ]));
      for (const name of [
        "issue_create_proposal", "manual_context_intake", "memory_remember",
        "work_create", "work_update", "work_control", "run_control"
      ]) {
        expect(kit.readOnlyToolNames).not.toContain(name);
      }
      const search = kit.customTools.find((tool) => tool.name === "capability_search")!;
      const invoke = kit.customTools.find((tool) => tool.name === "capability_invoke")!;
      const searched = await search.execute("search-1", { query: "project_list" }, undefined, undefined, {} as never);
      const match = (searched.details as any).matches[0];
      expect(match).toMatchObject({ permission: "read", tool_id: "runner-builtin:project_list" });
      expect(match.schema_hash).toMatch(/^[a-f0-9]{64}$/);
      const invoked = await invoke.execute("invoke-1", {
        arguments: {}, schema_hash: match.schema_hash, tool_id: match.tool_id
      }, undefined, undefined, {} as never);
      expect((invoked.details as any).status).not.toBe("failed");
      const targetAudit = listPiActionEvents(db, { conversationId: "conv-capability-audit" })
        .filter((event) => event.event_type === "tool_call_audit")
        .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
        .find((event) => event.tool === "project_list");
      expect(targetAudit).toMatchObject({
        permission: "read",
        provider_id: "runner-builtin",
        status: "succeeded",
        tool: "project_list"
      });
      for (const query of [
        "create a completion notification watch for an issue when it reaches a terminal result",
        "issue completion watch notification",
        "完成提醒",
        "有结果通知我"
      ]) {
        const result = await search.execute(`search-${query}`, { query }, undefined, undefined, {} as never);
        expect((result.details as any).matches[0], query).toMatchObject({
          name: "issue_completion_watch_create",
          permission: "write",
          required_parameters: ["issue_ids"],
          risk_level: "medium",
          tool_id: "runner-builtin:issue_completion_watch_create"
        });
        expect((result.details as any).matches[0].parameter_summary).toMatchObject({ issue_ids: "array<integer>" });
      }
    } finally {
      db.close();
    }
  });

  test("fails visibly instead of installing hardcoded tools when registry loading fails", async () => {
    const db = await openFixture();
    db.close();

    expect(() => createPiRuntimeToolKit(db)).toThrow();
  });

  test("marks a business-denied capability target as a tool error with the real gate reason", async () => {
    const db = await openFixture();
    try {
      db.sqlite.run(
        `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
         values ('demo', 'Demo', '/tmp/demo', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      );
      db.sqlite.run(
        `insert into issues (project_id, title, description, status, priority, created_at, updated_at)
         values ('demo', 'Denied candidate', '', 'triage', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
      );
      const project = getProject(db, "demo");
      if (!project) throw new Error("missing project");
      const kit = createPiRuntimeToolKit(db, project, {
        authorization: {
          allowedActions: ["issue.enqueue"],
          authorizedActions: [{ action_type: "issue.read" }],
          mode: "delegated",
          scope: { project_id: "demo" }
        },
        conversationID: "conv-capability-denied",
        source: "runner_chat"
      });
      const search = kit.customTools.find((tool) => tool.name === "capability_search")!;
      const invoke = kit.customTools.find((tool) => tool.name === "capability_invoke")!;
      const searched = await search.execute("search-denied", {
        query: "issue_enqueue_batch_triage"
      }, undefined, undefined, {} as never);
      const match = (searched.details as any).matches[0];

      await expect(invoke.execute("invoke-denied", {
        arguments: { issue_ids: [1], project_id: "demo", user_phrase: "#1" },
        schema_hash: match.schema_hash,
        tool_id: match.tool_id
      }, undefined, undefined, {} as never)).rejects.toThrow(/delegated action is not covered by authorization envelope/);

      const audits = listPiActionEvents(db, { conversationId: "conv-capability-denied" })
        .filter((event) => event.event_type === "tool_call_audit")
        .map((event) => JSON.parse(event.payload_json) as Record<string, unknown>)
        .filter((event) => event.tool === "issue_enqueue_batch_triage");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ status: "failed" });
    } finally {
      db.close();
    }
  });

  test("loads only the tool family required by each explicit runtime profile", async () => {
    const db = await openFixture();
    try {
      const full = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "chat", chatToolMode: "full" });
      const legacyFull = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "chat", chatToolMode: "legacy_full" });
      const review = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "chat", chatToolMode: "review" });
      const acceptance = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "acceptance" });
      const recovery = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "recovery" });
      const manager = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "manager_cycle" });
      const notification = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "notification" });

      expect(full.audit.tool_names).toEqual(expect.arrayContaining(["capability_search", "capability_invoke"]));
      expect(full.audit.tool_names).not.toContain("issue_delete");
      expect(legacyFull.audit.surface_mode).toBe("legacy_full");
      expect(legacyFull.audit.tool_names).toContain("issue_delete");
      expect(review.audit.tool_names).not.toContain("capability_search");
      expect(review.audit.tool_names).toContain("repo_read_excerpt");
      expect(review.audit.tool_names).not.toContain("issue_delete");
      expect(acceptance.audit.tool_names).toEqual(expect.arrayContaining(["issue_read", "repo_read_excerpt", "grep"]));
      expect(acceptance.audit.tool_names).not.toContain("memory_remember");
      expect(recovery.audit.tool_names).toEqual(expect.arrayContaining(["issue_state_diagnose", "memory_search"]));
      expect(recovery.audit.tool_names).not.toContain("work_control");
      expect(manager.audit.tool_names).toEqual(expect.arrayContaining(["work_control", "memory_remember"]));
      expect(manager.audit.tool_names).not.toContain("workspace_write_file");
      expect(notification.tools).toEqual([]);
      expect(notification.customTools).toEqual([]);
      expect(notification.readOnlyToolNames).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-runtime-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}
