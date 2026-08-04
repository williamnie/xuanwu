import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import {
  getStoredAssistantTool,
  listStoredAssistantTools,
  listStoredToolProviders,
  upsertAssistantTool,
  upsertToolProvider
} from "./toolRegistry.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("assistant tool registry repository", () => {
  test("starts empty and persists provider/tool metadata", async () => {
    const db = await openFixture();
    try {
      expect(listStoredToolProviders(db)).toEqual([]);
      expect(listStoredAssistantTools(db)).toEqual([]);

      const provider = upsertToolProvider(db, {
        audit: { redact: ["headers.authorization"] },
        description: "Fixture HTTP provider.",
        id: "fixture-http",
        kind: "http",
        metadata: { endpoint: "https://example.invalid" },
        name: "Fixture HTTP",
        status: "enabled"
      });
      const tool = upsertAssistantTool(db, {
        audit: { redact: ["input.token"] },
        description: "Read fixture status.",
        input_schema: { additionalProperties: false, properties: { token: { type: "string" } }, type: "object" },
        metadata: { source: "test" },
        name: "status_lookup",
        output_schema: { type: "object" },
        permission: "read",
        provider_id: provider.id
      });

      expect(listStoredToolProviders(db).map((item) => item.id)).toEqual(["fixture-http"]);
      expect(listStoredAssistantTools(db).map((item) => item.name)).toEqual(["status_lookup"]);
      expect(getStoredAssistantTool(db, tool.provider_id, tool.name)).toMatchObject({
        audit: { redact: ["input.token"] },
        input_schema: expect.objectContaining({ type: "object" }),
        permission: "read"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-tool-registry-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}
