import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
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
      const kit = createPiRuntimeToolKit(db);
      expect(kit.source).toBe("registry");
      expect(kit.tools).toEqual(expect.arrayContaining([
        "capability_invoke", "capability_search", "context_status", "issue_read",
        "project_status", "session_read_summary", URL_FETCH_TOOL_NAME
      ]));
      expect(kit.tools).not.toContain("issue_delete");
      const customToolNames = kit.customTools.map((tool) => tool.name).sort();
      expect(customToolNames).toEqual(expect.arrayContaining([
        "capability_invoke", "capability_search", "context_status", "issue_read", "project_status",
        URL_FETCH_TOOL_NAME
      ]));
      expect(customToolNames).not.toContain("issue_delete");
      expect(kit.audit.source).toBe("registry");
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
      expect(kit.readOnlyToolNames).toEqual(expect.arrayContaining([
        "read", "issue_list", "memory_search", "session_read_summary", "work_list", URL_FETCH_TOOL_NAME
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
    } finally {
      db.close();
    }
  });

  test("fails visibly instead of installing hardcoded tools when registry loading fails", async () => {
    const db = await openFixture();
    db.close();

    expect(() => createPiRuntimeToolKit(db)).toThrow();
  });

  test("loads only the tool family required by each explicit runtime profile", async () => {
    const db = await openFixture();
    try {
      const full = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "chat", chatToolMode: "full" });
      const review = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "chat", chatToolMode: "review" });
      const acceptance = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "acceptance" });
      const recovery = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "recovery" });
      const manager = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "manager_cycle" });
      const notification = createPiRuntimeToolKit(db, undefined, {}, { promptProfile: "notification" });

      expect(full.audit.tool_names).toEqual(expect.arrayContaining(["capability_search", "capability_invoke"]));
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
