import type { FeishuDiscoveryCandidate } from "../integrations/feishuSourceDiscovery.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfig, ENV_KEYS, loadConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-feishu-settings-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Feishu connector settings API", () => {
  test("controlled discovery verifies ingress, explicit scope, revision and concurrent settings ownership", async () => {
    const database = await openFixtureDatabase();
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const router = createDefaultRouter({ config, database });
      await request(router, { app_id: "cli_fixture", app_secret: "private-fixture", verification_token: "verify-fixture", receive_mode: "callback", allowed_chat_ids: ["oc_old"], allowed_user_ids: ["ou_old"], project_mappings: "chat:oc_old=demo" });
      const settings = await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/settings`))).json() as FeishuTestSettings;
      const session = await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery`, { method: "POST" }))).json() as { id: string; challenge: string };
      const inbound = { schema: "2.0", header: { event_type: "im.message.receive_v1", token: "wrong" }, event: { sender: { sender_type: "user", sender_id: { open_id: "ou_new" } }, message: { message_id: "m_new", chat_id: "oc_new", chat_type: "group", create_time: String(Date.now()), content: JSON.stringify({ text: session.challenge }) } } };
      const send = () => router.handle(new Request(`${BASE_URL}/api/integrations/feishu/events`, { method: "POST", body: JSON.stringify(inbound) }));
      expect((await send()).status).toBe(401);
      const read = async () => (await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery/${session.id}`))).json()) as { candidates: FeishuDiscoveryCandidate[] };
      expect((await read()).candidates).toHaveLength(0);
      inbound.header.token = "verify-fixture";expect((await send()).status).toBe(202);
      const candidate = (await read()).candidates[0];expect(candidate.user_id).toBe("ou_new");
      expect(database.sqlite.query("select count(*) as n from external_events").get()).toEqual({ n: 0 });
      const authorize = (body: Record<string, unknown>) => router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery/${session.id}/authorize`, { method: "POST", body: JSON.stringify(body) }));
      expect((await authorize({ candidate_id: "unseen", scope: "chat", expected_revision: settings.revision })).status).toBe(400);
      expect((await authorize({ candidate_id: candidate.id, scope: "chat", expected_revision: "stale" })).status).toBe(409);
      const result = await authorize({ candidate_id: candidate.id, scope: "chat", expected_revision: settings.revision });expect(result.status).toBe(200);
      const saved = await result.json() as FeishuTestSettings;expect(saved.allowed_chat_ids).toEqual(["oc_old", "oc_new"]);expect(saved.allowed_user_ids).toEqual(["ou_old"]);expect(saved.project_mappings).toBe("chat:oc_old=demo");expect(saved.app_secret_configured).toBe(true);
      expect((await authorize({ candidate_id: candidate.id, scope: "user", expected_revision: saved.revision })).status).toBe(409);
      const writes = await Promise.all([request(router, { default_chat_id: "oc_one", expected_revision: saved.revision }), request(router, { default_chat_id: "oc_two", expected_revision: saved.revision })]);
      expect(writes.map(item => item.status).sort()).toEqual([200, 409]);
      const secondSession = await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery`, { method: "POST" }))).json() as { id: string; challenge: string };
      inbound.event.message.content = JSON.stringify({ text: secondSession.challenge });
      inbound.event.message.message_id = "m_second";
      expect((await send()).status).toBe(202);
      const secondFacts = await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery/${secondSession.id}`))).json() as { candidates: FeishuDiscoveryCandidate[] };
      const latest = await (await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/settings`))).json() as FeishuTestSettings;
      const changedApp = await (await request(router, { app_id: "other_app", expected_revision: latest.revision })).json() as FeishuTestSettings;
      const rebound = await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/source-discovery/${secondSession.id}/authorize`, { method: "POST", body: JSON.stringify({ candidate_id: secondFacts.candidates[0]!.id, scope: "user", expected_revision: changedApp.revision }) }));
      expect(rebound.status).toBe(409);
      expect(config.integrations.feishu.allowedUserIds).toEqual(["ou_old"]);

    } finally { database.close(); }
  });
  test("saves local Feishu connector settings without echoing secrets", async () => {
    const database = await openFixtureDatabase();
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const router = createDefaultRouter({ config, database });

      const empty = await router.handle(new Request(`${BASE_URL}/api/integrations/feishu/settings`));
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({
        app_id: "",
        app_secret_configured: false,
        default_chat_id: "",
        default_user_id: "",
        enabled: false,
        verification_token_configured: false
      });

      const saved = await request(router, {
        allowed_chat_ids: "oc_a, oc_b",
        allowed_user_ids: ["ou_1"],
        app_id: "cli_app_id",
        app_secret: "app-secret-value",
        default_chat_id: "oc_default",
        default_user_id: "ou_default",
        encrypt_key: "encrypt-secret-value",
        project_mappings: "chat:oc_a=demo,user:ou_1=mobile",
        receive_mode: "websocket",
        verification_token: "verify-secret-value"
      });

      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({
        allowed_chat_ids: ["oc_a", "oc_b"],
        allowed_user_ids: ["ou_1"],
        app_id: "cli_app_id",
        app_secret_configured: true,
        default_chat_id: "oc_default",
        default_user_id: "ou_default",
        encrypt_key_configured: true,
        enabled: true,
        project_mappings: "chat:oc_a=demo,user:ou_1=mobile",
        public_url_required: false,
        receive_mode: "websocket",
        verification_token_configured: true
      });
      expect(JSON.stringify(savedBody)).not.toContain("app-secret-value");
      expect(JSON.stringify(savedBody)).not.toContain("encrypt-secret-value");
      expect(JSON.stringify(savedBody)).not.toContain("verify-secret-value");

      const raw = JSON.parse(await readFile(localSettingsPath(database), "utf8"));
      expect(raw.integrations.feishu).toMatchObject({
        allowedChatIds: ["oc_a", "oc_b"],
        allowedUserIds: ["ou_1"],
        appId: "cli_app_id",
        appSecretRef: "secret://integrations/feishu/app-secret",
        defaultChatId: "oc_default",
        defaultUserId: "ou_default",
        encryptKeyRef: "secret://integrations/feishu/encrypt-key",
        projectMappings: "chat:oc_a=demo,user:ou_1=mobile",
        receiveMode: "websocket",
        verificationTokenRef: "secret://integrations/feishu/verification-token"
      });
      const secretStore = await readFile(join(dirname(database.path), "secrets", "store.json"), "utf8");
      expect(secretStore).not.toContain("app-secret-value");
      expect(secretStore).not.toContain("encrypt-secret-value");
      expect(secretStore).not.toContain("verify-secret-value");
      const mode = (await stat(localSettingsPath(database))).mode & 0o777;
      expect(mode).toBe(0o600);
      const reloaded = loadConfig([], { [ENV_KEYS.stateDir]: dirname(database.path) });
      expect(reloaded.integrations.feishu).toMatchObject({
        appSecret: "app-secret-value",
        encryptKey: "encrypt-secret-value",
        verificationToken: "verify-secret-value"
      });
    } finally {
      database.close();
    }
  });

  test("keeps existing secrets when a settings form submits blank secret fields", async () => {
    const database = await openFixtureDatabase();
    try {
      const config = buildConfig({ dbPath: database.path, stateDir: dirname(database.path) });
      const router = createDefaultRouter({ config, database });
      await request(router, {
        app_id: "cli_app_id",
        app_secret: "old-secret",
        verification_token: "old-token"
      });

      const updated = await request(router, {
        app_id: "cli_new",
        app_secret: "",
        verification_token: "",
        encrypt_key: ""
      });

      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({
        app_id: "cli_new",
        app_secret_configured: true,
        verification_token_configured: true
      });
      const raw = JSON.parse(await readFile(localSettingsPath(database), "utf8"));
      expect(raw.integrations.feishu).toMatchObject({
        appId: "cli_new",
        appSecretRef: "secret://integrations/feishu/app-secret",
        verificationTokenRef: "secret://integrations/feishu/verification-token"
      });
    } finally {
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}/api/integrations/feishu/settings`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function localSettingsPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "runner-settings.local.json");
}

type FeishuTestSettings = { revision: string; allowed_chat_ids: string[]; allowed_user_ids: string[]; project_mappings: string; app_secret_configured: boolean };
