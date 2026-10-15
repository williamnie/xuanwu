import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { localSettingsPath } from "../config/localSettings.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { ingestFeishuMessageEvent } from "../integrations/feishuIngest.ts";
import type { FeishuCredentialCheck } from "../integrations/feishuClient.ts";
import { registerFeishuSettingsRoutes } from "./feishuSettingsApi.ts";
import { createRouter } from "./router.ts";

const fixtures: Array<{ root: string; database: RunnerDatabase }> = [];
afterEach(async () => {
  for (const { root, database } of fixtures.splice(0)) {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(configured = true) {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-discovery-"));
  const database = await openDatabase({ stateDir: root });
  fixtures.push({ root, database });
  const config = buildConfig({ stateDir: root, dbPath: database.path,
    feishuAppId: configured ? "cli_saved" : "", feishuAppSecret: configured ? "saved-private-secret" : "",
    feishuAllowedChatIds: "oc_existing", feishuAllowedUserIds: "ou_existing" });
  const path = localSettingsPath(root);
  await writeFile(path, JSON.stringify({ integrations: { feishu: {
    allowedChatIds: ["oc_existing"], allowedUserIds: ["ou_existing"], appId: config.integrations.feishu.appId
  } } }, null, 2));
  const originalFile = await readFile(path, "utf8");
  const state = { checks: 0, reads: 0, result: { ok: true } as FeishuCredentialCheck };
  const sqlite = database.sqlite;
  database.sqlite = new Proxy(sqlite, {
    get(target, key) {
      if (key === "query") return (sql: string) => {
        if (sql.includes("where source='feishu'")) {
          expect(state.checks).toBeGreaterThan(0);
          expect(state.result.ok).toBe(true);
          state.reads += 1;
        }
        return target.query(sql);
      };
      return Reflect.get(target, key);
    }
  });
  const router = createRouter();
  registerFeishuSettingsRoutes(router, { config, database, validateCredentials: async (saved) => {
    state.checks += 1;
    expect(saved.appId).toBe("cli_saved");
    expect(saved.appSecret).toBe("saved-private-secret");
    return state.result;
  } });
  return { database, config, state, async discover(body: unknown = {}) {
    // Discovery must succeed while the entire database is read-only.
    database.sqlite.run("pragma query_only=on");
    const response = await router.handle(new Request("http://localhost/api/integrations/feishu/discover-source", {
      method: "POST", body: JSON.stringify(body)
    }));
    const result = await response.json() as any;
    expect(await readFile(path, "utf8")).toBe(originalFile);
    expect(config.integrations.feishu.allowedChatIds).toEqual(["oc_existing"]);
    expect(config.integrations.feishu.allowedUserIds).toEqual(["ou_existing"]);
    const serialized = JSON.stringify(result);
    for (const forbidden of ["text", "raw", "app_secret", "token", "saved-private-secret", "private-message-body"]) expect(serialized).not.toContain(forbidden);
    return { status: response.status, body: result };
  } };
}

function event(db: RunnerDatabase, id: string, options: { chat?: string; user?: string; openId?: string; kind?: string; at?: string; source?: string } = {}) {
  return createExternalEvent(db, {
    source: options.source ?? "feishu", dedupe_key: id, content: "private-message-body",
    normalized_message: { text: "private-message-body", raw: { app_secret: "hidden-secret", token: "hidden-value" },
      conversation: { id: options.chat ?? "oc_group", kind: "group", title: "Do not expose this name" },
      sender: { id: options.user ?? "user_1", open_id: options.openId ?? "ou_first", kind: options.kind ?? "user", display_name: "Do not expose this name" },
      occurred_at: options.at ?? "2026-10-15T10:00:00Z" }
  });
}

test("Feishu discovery validates saved credentials then returns no candidates without writing settings", async () => {
  const f = await fixture();
  expect(await f.discover()).toEqual({ status: 200, body: { ok: true, sources: [] } });
  expect(f.state).toMatchObject({ checks: 1, reads: 1 });
});

test("Feishu discovery includes ignored receipts and returns only safe source metadata", async () => {
  const f = await fixture();
  const ignored = ingestFeishuMessageEvent({ event: {
    message: { message_id: "om_ignored", chat_id: "oc_unlisted", chat_type: "p2p", create_time: "2026-10-15T12:00:00Z", content: JSON.stringify({ text: "private-message-body" }) },
    sender: { sender_id: { user_id: "user_unlisted", open_id: "ou_unlisted" }, sender_type: "user" }
  } }, { database: f.database, config: f.config.integrations.feishu }, { transport: "websocket" });
  expect(f.database.sqlite.query("select status from external_events where id=?").get(ignored.event_id)).toEqual({ status: "ignored" });
  const response = await f.discover();
  expect(response.status).toBe(200);
  expect(response.body.sources).toEqual([{
    chat_id: "oc_unlisted", chat_title: "", chat_type: "direct", observed_at: "2026-10-15T12:00:00.000Z",
    user_display_name: "", user_id: "ou_unlisted"
  }]);
});

test("Feishu discovery deduplicates by chat and preferred user ID using the latest event time, excluding bots", async () => {
  const f = await fixture();
  event(f.database, "newest", { at: "2026-10-15T12:00:00Z" });
  event(f.database, "late-old-receipt", { at: "2026-10-14T12:00:00Z" });
  event(f.database, "other-chat", { chat: "oc_other", at: "2026-10-15T11:00:00Z" });
  event(f.database, "fallback-user", { openId: "", user: "user_fallback" });
  for (const kind of ["bot", "app", "unknown"]) event(f.database, kind, { user: kind, openId: `ou_${kind}`, kind });
  event(f.database, "other-source", { source: "telegram", openId: "ou_telegram" });
  const result = await f.discover();
  expect(result.body.sources.map((source: any) => [source.chat_id, source.user_id, source.observed_at])).toEqual([
    ["oc_group", "ou_first", "2026-10-15T12:00:00.000Z"],
    ["oc_other", "ou_first", "2026-10-15T11:00:00.000Z"],
    ["oc_group", "user_fallback", "2026-10-15T10:00:00.000Z"]
  ]);
  expect(result.body.sources.every((source: any) => source.chat_title === "" && source.user_display_name === "")).toBe(true);
});

test("Feishu discovery scans at most the latest 200 Feishu receipts including ignored and malformed entries", async () => {
  const f = await fixture();
  event(f.database, "older-than-window", { openId: "ou_old" });
  for (let i = 0; i < 200; i += 1) event(f.database, `recent-${i}`);
  createExternalEvent(f.database, { source: "feishu", dedupe_key: "malformed", content: "private-message-body", normalized_message_json: "{bad" });
  const result = await f.discover();
  expect(result.body.sources).toHaveLength(1);
  expect(result.body.sources[0].user_id).toBe("ou_first");
  expect(f.state.reads).toBe(1);
});

test("Feishu discovery rejects missing configuration and draft credentials before checking or reading history", async () => {
  const missing = await fixture(false);
  expect((await missing.discover()).status).toBe(400);
  expect(missing.state).toMatchObject({ checks: 0, reads: 0 });
  const f = await fixture();
  for (const body of [null, [], [{ app_secret: "draft-value" }], "draft-value", { app_id: "cli_draft", app_secret: "draft-value" }]) {
    expect((await f.discover(body)).status).toBe(400);
  }
  expect(f.state).toMatchObject({ checks: 0, reads: 0 });
});

test("Feishu discovery fails closed before history reads with 400 for invalid credentials and 502 for network or timeout", async () => {
  const f = await fixture();
  for (const [kind, status, message] of [["auth", 400, "凭据无效"], ["network", 502, "无法连接飞书"], ["timeout", 502, "超时"]] as const) {
    f.state.result = { ok: false, kind };
    const result = await f.discover();
    expect(result.status).toBe(status);
    expect(JSON.stringify(result.body)).toContain(message);
  }
  expect(f.state).toMatchObject({ checks: 3, reads: 0 });
});
