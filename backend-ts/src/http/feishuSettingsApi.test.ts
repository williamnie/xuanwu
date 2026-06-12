import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, mkdtemp, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-feishu-settings-"));
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
        enabled: false,
        verification_token_configured: false
      });

      const saved = await request(router, {
        allowed_chat_ids: "oc_a, oc_b",
        allowed_user_ids: ["ou_1"],
        app_id: "cli_app_id",
        app_secret: "app-secret-value",
        encrypt_key: "encrypt-secret-value",
        project_mappings: "chat:oc_a=demo,user:ou_1=mobile",
        verification_token: "verify-secret-value"
      });

      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({
        allowed_chat_ids: ["oc_a", "oc_b"],
        allowed_user_ids: ["ou_1"],
        app_id: "cli_app_id",
        app_secret_configured: true,
        encrypt_key_configured: true,
        enabled: true,
        project_mappings: "chat:oc_a=demo,user:ou_1=mobile",
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
        appSecret: "app-secret-value",
        encryptKey: "encrypt-secret-value",
        projectMappings: "chat:oc_a=demo,user:ou_1=mobile",
        verificationToken: "verify-secret-value"
      });
      const mode = (await stat(localSettingsPath(database))).mode & 0o777;
      expect(mode).toBe(0o600);
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
        appSecret: "old-secret",
        verificationToken: "old-token"
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
