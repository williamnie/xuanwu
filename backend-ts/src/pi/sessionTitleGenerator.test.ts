import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { updatePiSupervisor } from "../db/repositories/pi.ts";
import { generateSessionTitle } from "./sessionTitleGenerator.ts";
import type { CodexThreadTitleInput } from "../providers/codex/threadNaming.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-title-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: root });
  db.sqlite.run("insert into projects (id, name, cwd, created_at, updated_at) values ('demo', '玄武', '/tmp/demo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')");
  db.sqlite.run("insert into issues (id, project_id, title, description, status, created_at, updated_at) values (913, 'demo', '优化批次文字显示', '调整长文本显示，提高可读性', 'todo', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')");
  const input: CodexThreadTitleInput = {
    thread: { id: "codex:t1", provider_session_id: "t1", sessionId: "t1", provider: "codex", ephemeral: false,
      name: "Issue #913", createdAt: Date.parse("2026-09-02T16:00:00Z") / 1000, updatedAt: Date.parse("2026-09-10T00:00:00Z") / 1000 },
    issueId: 913, projectId: "demo", cwd: "/tmp/demo", prompt: "执行器内部提示词，不应传给标题模型"
  };
  return { root, db, input };
}

describe("通过 PI 模型配置直接生成标题", () => {
  test("真实 SDK 仅发出一次无工具请求，使用原始 Issue 内容，不创建 PI 会话", async () => {
    const { root, db, input } = await fixture();
    const requests: Record<string, any>[] = [];
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      expect(request.headers.get("authorization")).toBe("Bearer fixture-title-key");
      requests.push(await request.json() as Record<string, any>);
      const chunks = [
        { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: '{"title":"0903｜优化｜批次文字显示"}' }, finish_reason: null }] },
        { id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }
      ];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "Content-Type": "text/event-stream" }
      });
    } });
    try {
      const agentDir = join(root, "pi-runtime", "agent");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
        "title-test": { api: "openai-completions", apiKey: "fixture-title-key", baseUrl: `${server.url}v1`, models: [{ id: "title-model" }] }
      } }));
      updatePiSupervisor(db, { model_provider: "title-test", model_id: "title-model" });
      const before = db.sqlite.query("select * from projects").all();
      const title = await generateSessionTitle(db, input, new AbortController().signal);
      expect(title).toBe("0903｜优化｜批次文字显示");
      expect(requests).toHaveLength(1);
      expect(requests[0]!.model).toBe("title-model");
      expect(requests[0]!.tools ?? []).toEqual([]);
      const message = requests[0]!.messages.find((item: any) => item.role === "user");
      expect(JSON.parse(message.content)).toEqual({ titleDate: "0903", currentTitle: "Issue #913", projectName: "玄武", conversationContent: "优化批次文字显示\n\n调整长文本显示，提高可读性" });
      expect(db.sqlite.query("select * from projects").all()).toEqual(before);
      expect(db.sqlite.query("select * from pi_conversations").all()).toEqual([]);
      expect(db.sqlite.query("select * from agent_sessions").all()).toEqual([]);
      expect(existsSync(join(root, "pi-runtime", "sessions"))).toBe(false);
    } finally { server.stop(true); db.close(); }
  });

  test("createdAt 缺失时不能用 updatedAt 补日期", async () => {
    const { db, input } = await fixture();
    try {
      delete input.thread.createdAt;
      expect(await generateSessionTitle(db, input, new AbortController().signal)).toBeNull();
    } finally { db.close(); }
  });
});
