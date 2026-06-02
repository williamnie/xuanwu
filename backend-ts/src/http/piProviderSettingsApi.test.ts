import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { getModel } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-provider-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI provider settings API", () => {
  test("upserts models.json providers without echoing API keys", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const empty = await router.handle(new Request(`${BASE_URL}/api/pi/provider-settings`));
      expect(empty.status).toBe(200);
      expect(await empty.json()).toMatchObject({ providers: [] });

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://api.openai.example/v1",
        models: ["gpt-5.4", "gpt-5.5"]
      });

      expect(saved.status).toBe(200);
      const savedBody = await saved.json();
      expect(savedBody).toMatchObject({
        id: "openai",
        api: "openai-responses",
        api_key_configured: true,
        base_url: "https://api.openai.example/v1",
        models: ["gpt-5.4", "gpt-5.5"]
      });
      expect(JSON.stringify(savedBody)).not.toContain("secret-key");

      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai.apiKey).toBe("secret-key");
      expect(raw.providers.openai.models).toEqual([]);
      expect(Object.keys(raw.providers.openai.modelOverrides)).toEqual(["gpt-5.4", "gpt-5.5"]);

      await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "",
        base_url: "https://proxy.example/v1",
        models: "gpt-5.5"
      });
      const updated = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(updated.providers.openai).toMatchObject({
        apiKey: "secret-key",
        baseUrl: "https://proxy.example/v1",
        models: [],
        modelOverrides: { "gpt-5.5": {} }
      });
    } finally {
      database.close();
    }
  });

  test("does not replace built-in model metadata when saving built-in providers", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const builtIn = getModel("openai", "gpt-5.5");
      expect(builtIn?.contextWindow).toBeGreaterThan(128000);

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        api_key: "secret-key",
        base_url: "https://proxy.example/v1",
        models: "gpt-5.5"
      });

      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ models: ["gpt-5.5"] });
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai.models).toEqual([]);
      expect(raw.providers.openai.modelOverrides).toEqual({ "gpt-5.5": {} });
      expect(JSON.stringify(raw.providers.openai)).not.toContain("\"contextWindow\":128000");
    } finally {
      database.close();
    }
  });

  test("keeps existing provider compatibility fields while updating", async () => {
    const database = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await writeSeedModels(database, {
        providers: {
          openai: {
            api: "openai-completions",
            apiKey: "old-key",
            baseUrl: "https://old.example/v1",
            compat: { disableParallelToolCalls: true },
            models: [{ id: "old-model" }]
          }
        }
      });

      const saved = await request(router, "/api/pi/provider-settings/openai", {
        api: "openai-responses",
        base_url: "https://new.example/v1",
        models: ["new-model"]
      });

      expect(saved.status).toBe(200);
      const raw = JSON.parse(await readFile(modelsPath(database), "utf8"));
      expect(raw.providers.openai).toMatchObject({
        api: "openai-responses",
        apiKey: "old-key",
        baseUrl: "https://new.example/v1",
        compat: { disableParallelToolCalls: true },
        models: [{ id: "new-model" }]
      });
    } finally {
      database.close();
    }
  });
});

function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

function modelsPath(database: RunnerDatabase): string {
  return join(dirname(database.path), "pi-runtime", "agent", "models.json");
}

async function writeSeedModels(database: RunnerDatabase, value: Record<string, unknown>): Promise<void> {
  const path = modelsPath(database);
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}
