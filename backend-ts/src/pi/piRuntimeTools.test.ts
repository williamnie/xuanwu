import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS } from "../http/piProjectTools.ts";
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
      expect(kit.tools).toEqual([...PI_ALLOWED_TOOLS]);
      expect(kit.customTools.map((tool) => tool.name).sort())
        .toEqual(createPiProjectTools(db).map((tool) => tool.name).sort());
      expect(kit.audit).toMatchObject({
        provider_ids: ["runner-builtin"],
        source: "registry"
      });
      expect(kit.audit.tool_names).toEqual(expect.arrayContaining([
        "read",
        "issue_create_proposal",
        "issue_enqueue_proposal",
        "memory_search"
      ]));
    } finally {
      db.close();
    }
  });

  test("falls back to legacy hardcoded tools when registry loading fails", async () => {
    const db = await openFixture();
    db.close();

    const kit = createPiRuntimeToolKit(db);

    expect(kit.source).toBe("fallback");
    expect(kit.tools).toEqual([...PI_ALLOWED_TOOLS]);
    expect(kit.customTools.map((tool) => tool.name).sort())
      .toEqual(createPiProjectTools(db).map((tool) => tool.name).sort());
    expect(kit.audit.registry_error).toEqual(expect.any(String));
    expect(kit.audit.provider_ids).toEqual(["hardcoded-pi-runtime"]);
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-runtime-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}
