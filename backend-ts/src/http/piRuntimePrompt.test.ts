import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";

describe("PI runtime prompt", () => {
  test("documents repo-aware issue proposal workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-prompt-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "conv-repo-aware",
        project: projectRecord(join(root, "project"))
      }, db);

      expect(prompt).toContain("Repo-aware issue proposal workflow:");
      expect(prompt).toContain("repo_search");
      expect(prompt).toContain("repo_context_pack");
      expect(prompt).toContain("issue_create_proposal");
      expect(prompt).toContain("需求理解");
      expect(prompt).toContain("最多追问一个关键问题");
      expect(prompt).toContain("must not edit code");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tells PI to answer Feishu chat naturally without forcing issue workflow", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-prompt-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "feishu-oc_group",
        project: undefined
      }, db);

      expect(prompt).toContain("Feishu/IM normal chat");
      expect(prompt).toContain("reply naturally");
      expect(prompt).toContain("Do not ask for a project mapping");
      expect(prompt).toContain("same language as the user");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("tells PI to start IM-created issues by default unless the user asks to wait", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-prompt-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "conv-im-default-run",
        project: projectRecord(join(root, "project"))
      }, db);

      expect(prompt).toContain("Feishu/IM task messages");
      expect(prompt).toContain("call issue_enqueue_proposal by default");
      expect(prompt).toContain("issue_enqueue_next_triage");
      expect(prompt).toContain("继续做下一个");
      expect(prompt).toContain("issue_enqueue_batch_triage");
      expect(prompt).toContain("#387-#391");
      expect(prompt).toContain("issue_ids");
      expect(prompt).toContain("完成所有");
      expect(prompt).toContain("开始做吧");
      expect(prompt).toContain("ordinary/high-risk paths must stay behind the gate");
      expect(prompt).toContain("Only wait");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps confirmed memory injection for new Feishu conversation ids without old conversation memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-prompt-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      createPiMemoryItem(db, {
        content: "Project-level Feishu preference",
        id: "feishu-project-memory",
        kind: "preference",
        scope: "project",
        scope_id: "demo"
      });
      createPiMemoryItem(db, {
        content: "Global PI behavior",
        id: "feishu-global-memory",
        kind: "policy",
        scope: "global"
      });
      createPiMemoryItem(db, {
        content: "Old chat conversation memory",
        id: "feishu-old-conversation-memory",
        kind: "conversation_note",
        scope: "conversation",
        scope_id: "feishu-chat-oc_group-20260613"
      });

      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "feishu-chat-oc_group-20260613-n1",
        project: projectRecord(join(root, "project"))
      }, db);

      expect(prompt).toContain("Confirmed PI memory:");
      expect(prompt).toContain("Project-level Feishu preference");
      expect(prompt).toContain("Global PI behavior");
      expect(prompt).not.toContain("Old chat conversation memory");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function agentRecord() {
  return {
    id: "pi-faux", name: "PI Faux", provider: "pi-sdk", model_provider: "pi-tools", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  } as never;
}

function projectRecord(cwd: string) {
  return {
    id: "demo", name: "Demo", cwd, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped",
    provider_capabilities: []
  } as never;
}
