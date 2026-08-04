import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";

describe("i18n API", () => {
  test("persists the selected application language and injects it into the PI prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-i18n-"));
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      const router = createDefaultRouter({ database });
      const initial = await router.handle(new Request(`${BASE_URL}/api/i18n`));
      expect(await initial.json()).toEqual({ language: "zh-CN", supported_languages: ["zh-CN", "en-US"] });

      const saved = await router.handle(new Request(`${BASE_URL}/api/i18n`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "en-US" })
      }));
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ language: "en-US" });

      const summary = await router.handle(new Request(`${BASE_URL}/api/pi/supervisor/runtime-prompt`));
      expect(await summary.json()).toMatchObject({
        runtime_prompt_summary: {
          language: "en-US",
          model_output_language: "English"
        }
      });

      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "i18n-prompt",
        promptProfile: "chat",
      }, database);
      expect(prompt).toContain("current system language is English (en-US)");
      expect(prompt).toContain("must be in English");
      expect(prompt).not.toContain("same language as the user's latest message");
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsupported languages without changing the preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-i18n-invalid-"));
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      const router = createDefaultRouter({ database });
      const response = await router.handle(new Request(`${BASE_URL}/api/i18n`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "fr-FR" })
      }));
      expect(response.status).toBe(400);
      const current = await router.handle(new Request(`${BASE_URL}/api/i18n`));
      expect(await current.json()).toMatchObject({ language: "zh-CN" });
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function agentRecord() {
  return {
    id: "runner-default", name: "Xuanwu Supervisor", enabled: 1, provider: "openai-codex", model_provider: "openai-codex",
    model_id: "gpt-5.1-codex-mini", thinking_level: "low", cwd_policy: "project", tools_json: "[]", instructions: "", max_concurrent_runs: 1,
    status: "idle", created_at: "2026-07-27T00:00:00.000Z", updated_at: "2026-07-27T00:00:00.000Z"
  };
}
