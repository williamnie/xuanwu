import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import {
  createPiNotificationPreferenceTools,
  PI_NOTIFICATION_PREFERENCE_TOOL_NAMES
} from "./notificationPreferenceTools.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("PI notification preference tools", () => {
  test("lets PI write structured preference fields without command parsing", async () => {
    const db = await fixture();
    try {
      const tools = createPiNotificationPreferenceTools(db, {
        conversationID: "conv-notify",
        projectID: "demo",
        source: "runner_chat"
      });
      expect(tools.map((tool) => tool.name)).toEqual([...PI_NOTIFICATION_PREFERENCE_TOOL_NAMES]);

      const updated = await runTool(tools, "notification_preference_update", {
        mode: "quiet",
        notify_on: ["urgent", "pi_unavailable"],
        scope: "conversation",
        temporary: true,
        ttl_minutes: 60
      });
      const read = await runTool(tools, "notification_preference_read", {});

      expect(updated.details).toMatchObject({
        confirmation_text: expect.stringContaining("mode=quiet"),
        preference: {
          conversation_id: "conv-notify",
          mode: "quiet",
          scope: "conversation"
        }
      });
      expect(read.details).toMatchObject({
        effective: {
          mode: "quiet",
          notify_on: ["urgent", "pi_unavailable"]
        },
        source: "conversation"
      });
      expect(listPiActions(db).map((action) => [action.action_type, action.status]).sort()).toEqual([
        ["notification.preference.read", "completed"],
        ["notification.preference.update", "completed"]
      ]);
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "pi-notification-tools-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function runTool(tools: ReturnType<typeof createPiNotificationPreferenceTools>, name: string, input: Record<string, unknown>) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return await tool.execute(`call-${name}`, input, undefined, undefined, {} as never) as {
    content: Array<{ text?: string; type: string }>;
    details: unknown;
  };
}
