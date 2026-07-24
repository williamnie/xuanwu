import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createExternalEvent,
  listExternalEvents,
  type ExternalEventAttachmentInput
} from "../db/repositories/externalEvents.ts";
import { listContextBundles } from "../db/repositories/contextBundles.ts";
import { listAttentionInboxItems, listIntakeRuns } from "../db/repositories/intakeRuns.ts";
import { listPiActions } from "../db/repositories/pi.ts";
import { runManualContextIntake } from "./manualTrigger.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("manual context intake trigger", () => {
  test("requires a source when multiple recent sources are available", async () => {
    const db = await openFixtureDatabase();
    try {
      event(db, "fixture-im", "m1", "群里有截图");
      event(db, "other-im", "m2", "另一个来源");

      const result = await runManualContextIntake(db, {
        now: "2026-07-06T01:10:00Z",
        user_prompt: "看看刚刚群里的截图和消息"
      });

      expect(result).toMatchObject({ reason: "source_required", status: "needs_user" });
      expect(result.text).toContain("请指定来源");
      expect(listContextBundles(db)).toEqual([]);
      expect(listIntakeRuns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("returns context to PI without guessing project, intent, or action", async () => {
    const db = await openFixtureDatabase();
    try {
      event(db, "fixture-im", "m1", "登录页 500 了");
      event(db, "fixture-im", "m2", "截图如下", [{ kind: "image", name: "login.png" }]);

      const result = await runManualContextIntake(db, {
        now: "2026-07-06T01:10:00Z",
        require_attachments: true,
        source: "fixture-im",
        user_prompt: "看看刚刚群里的截图和消息，是个 bug，创建 issue"
      });
      expect(result).toMatchObject({
        reason: "manual_context_bundle_ready",
        status: "succeeded",
        text: expect.stringContaining("请由 PI")
      });
      expect(listIntakeRuns(db)).toEqual([]);
      expect(listAttentionInboxItems(db)).toEqual([]);
      expect(listPiActions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("pulls read-only source connector when local events are missing and dedupes reruns", async () => {
    const db = await openFixtureDatabase();
    const dir = await writeSourceConnector("fixture-im");
    try {
      const input = {
        cursor: "wm-0",
        lookback_minutes: 30,
        now: "2026-07-06T01:10:00Z",
        project_id: "demo",
        require_attachments: true,
        source: "fixture-im",
        source_provider_id: "fixture-im",
        source_tool_name: "pull-events",
        thread_key: "thread-a",
        user_prompt: "看看刚刚群里的截图和消息，是个 bug，创建 issue"
      };

      const first = await runManualContextIntake(db, input, { connectorManifestDirs: [dir], env: {} });
      const firstCounts = manualPipelineCounts(db);
      const second = await runManualContextIntake(db, input, { connectorManifestDirs: [dir], env: {} });

      expect(first).toMatchObject({ status: "succeeded" });
      expect(first.bundle).toMatchObject({ created_by: "user", source: "fixture-im", trigger: "manual" });
      expect(first.bundle?.source_query).toMatchObject({
        cursor: "wm-0",
        processed_watermark: "wm-1",
        source_pull: expect.objectContaining({
          provider_id: "fixture-im",
          status: "succeeded",
          tool_name: "pull-events"
        })
      });
      expect(listAttentionInboxItems(db, { source: "fixture-im" })).toEqual([]);
      expect(listIntakeRuns(db)).toEqual([]);
      expect(listPiActions(db)).toEqual([]);
      expect(listExternalEvents(db, { source: "fixture-im" })).toHaveLength(2);
      expect(second).toMatchObject({ status: "succeeded" });
      expect(manualPipelineCounts(db)).toEqual(firstCounts);
    } finally {
      db.close();
    }
  });

  test("returns needs_user when the source connector is not authorized", async () => {
    const db = await openFixtureDatabase();
    const dir = await writeSourceConnector("locked-im", { requiredEnv: "LOCKED_IM_TOKEN" });
    try {
      const result = await runManualContextIntake(db, {
        now: "2026-07-06T01:10:00Z",
        source: "locked-im",
        source_provider_id: "locked-im",
        source_tool_name: "pull-events",
        user_prompt: "看看刚刚群里的截图和消息"
      }, { connectorManifestDirs: [dir], env: {} });

      expect(result).toMatchObject({ reason: "source_pull_unauthorized", status: "needs_user" });
      expect(result.text).toContain("授权");
      expect(listExternalEvents(db, { source: "locked-im" })).toEqual([]);
      expect(listContextBundles(db)).toEqual([]);
      expect(listIntakeRuns(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-manual-trigger-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function writeSourceConnector(
  id: string,
  options: { requiredEnv?: string } = {}
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-manual-source-"));
  tempRoots.push(root);
  const script = join(root, `${id}.mjs`);
  await mkdir(root, { recursive: true });
  await writeFile(script, SOURCE_CONNECTOR_SCRIPT, "utf8");
  await writeFile(join(root, `${id}.json`), JSON.stringify(sourceConnectorManifest(id, script, options), null, 2), "utf8");
  return root;
}

function sourceConnectorManifest(
  id: string,
  script: string,
  options: { requiredEnv?: string }
): Record<string, unknown> {
  return {
    commands: [{
      command: {
        args: [
          script, "pull", "{{input.source}}", "{{input.since}}", "{{input.thread_key}}",
          "{{input.message_id}}", "{{input.cursor}}", "{{input.limit}}", "{{input.attachment_kinds}}"
        ],
        executable: process.execPath
      },
      description: "Pull recent fixture source events for manual context intake.",
      exit_codes: { success: [0] },
      input_schema: {
        properties: {
          attachment_kinds: { items: { type: "string" }, type: "array" },
          cursor: { type: "string" },
          limit: { type: "integer" },
          message_id: { type: "string" },
          since: { type: "string" },
          source: { type: "string" },
          thread_key: { type: "string" },
          until: { type: "string" }
        },
        type: "object"
      },
      name: "pull-events",
      output_schema: {
        properties: {
          events: { type: "array" },
          processed_watermark: { type: "string" },
          source: { type: "string" }
        },
        type: "object"
      },
      permission: "read",
      stdout: { mode: "json" }
    }],
    env: options.requiredEnv ? [{ name: options.requiredEnv, required: true, secret: true }] : [],
    health: {
      command: { args: [script, "health"], executable: process.execPath },
      exit_codes: { success: [0] },
      stdout: { mode: "json" }
    },
    id,
    kind: "cli",
    manifest_version: "pi-cli-connector.v0",
    name: id
  };
}

function manualPipelineCounts(db: RunnerDatabase): Record<string, number> {
  return {
    actions: listPiActions(db).filter((action) => action.action_type === "attention_inbox.domain_skill").length,
    inboxItems: listAttentionInboxItems(db, { source: "fixture-im" }).length,
    rawEvents: listExternalEvents(db, { source: "fixture-im" }).length
  };
}

function event(
  db: RunnerDatabase,
  source: string,
  externalID: string,
  content: string,
  attachments: ExternalEventAttachmentInput[] = []
): void {
  createExternalEvent(db, {
    attachments,
    content,
    external_id: externalID,
    normalized_message: {
      chat_id: "group-1",
      chat_type: "group",
      message_id: externalID,
      thread_id: "thread-a"
    },
    occurred_at: `2026-07-06T01:0${externalID.slice(1)}:00Z`,
    provider: source,
    raw_json: { text: content },
    received_at: `2026-07-06T01:0${externalID.slice(1)}:00Z`,
    source
  });
}

const SOURCE_CONNECTOR_SCRIPT = `
const mode = process.argv[2];
if (mode === "health") {
  console.log(JSON.stringify({ ok: true }));
} else {
  const source = process.argv[3] || "fixture-im";
  console.log(JSON.stringify({
    source,
    processed_watermark: "wm-1",
    events: [
      {
        actor: "alice",
        attachments: [{ kind: "image", mime_type: "image/png", name: "login.png" }],
        content: "登录页 500 了，截图里有报错",
        dedupe_key: source + ":m1",
        event_type: "message",
        external_id: "m1",
        normalized_message: { chat_id: "group-1", chat_type: "group", message_id: "m1", thread_id: "thread-a" },
        occurred_at: "2026-07-06T01:01:00Z",
        received_at: "2026-07-06T01:01:01Z",
        source_ref: source + ":m1"
      },
      {
        actor: "bob",
        content: "请帮忙创建 issue",
        dedupe_key: source + ":m2",
        event_type: "message",
        external_id: "m2",
        normalized_message: { chat_id: "group-1", chat_type: "group", message_id: "m2", thread_id: "thread-a" },
        occurred_at: "2026-07-06T01:02:00Z",
        received_at: "2026-07-06T01:02:01Z",
        source_ref: source + ":m2"
      }
    ]
  }));
}
`;
