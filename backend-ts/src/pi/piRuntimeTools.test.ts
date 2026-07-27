import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS } from "../http/piProjectTools.ts";
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
  test("assembles builtin runtime tools from registry with legacy tool names", async () => {
    const db = await openFixture();
    try {
      const kit = createPiRuntimeToolKit(db);
      expect(kit.source).toBe("registry");
      expect(kit.tools).toEqual(expect.arrayContaining([...PI_ALLOWED_TOOLS, URL_FETCH_TOOL_NAME]));
      const customToolNames = kit.customTools.map((tool) => tool.name).sort();
      expect(customToolNames).toEqual(expect.arrayContaining([
        ...createPiProjectTools(db).map((tool) => tool.name),
        URL_FETCH_TOOL_NAME
      ]));
      expect(kit.audit.source).toBe("registry");
      expect(kit.audit.tool_names).toEqual(expect.arrayContaining([
        "read",
        URL_FETCH_TOOL_NAME,
        "issue_create_proposal",
        "issue_enqueue_proposal",
        "memory_search",
        "work_list",
        "run_control",
        "evidence_read",
        "handoff_read"
      ]));
      expect(kit.audit.custom_tool_names).toContain(URL_FETCH_TOOL_NAME);
      expect(kit.audit.provider_ids).toEqual(expect.arrayContaining(["runner-builtin", HTTP_READONLY_PROVIDER_ID]));
      expect(kit.readOnlyToolNames).toEqual(expect.arrayContaining([
        "read", "issue_list", "memory_search", "work_list", "run_read", "evidence_read", "handoff_read", URL_FETCH_TOOL_NAME
      ]));
      for (const name of [
        "issue_create_proposal", "manual_context_intake", "memory_remember",
        "work_create", "work_update", "work_control", "run_control"
      ]) {
        expect(kit.readOnlyToolNames).not.toContain(name);
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
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-runtime-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}
