import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const DECISION_FIXTURES = [
    {
      kind: "question",
      user: "你能做什么？",
      expected: "1. Answer: for greetings, capability questions, explanations, and how-to questions"
    },
    {
      kind: "investigation",
      user: "先调查为什么最近的 Run 失败，不要改状态",
      expected: "2. Investigate: for diagnosis or research, use bounded read-only"
    },
    {
      kind: "query",
      user: "这个项目还有多少 Work 没完成？",
      expected: "3. Query: for counts, status, progress, or history, read the authoritative compact view"
    },
    {
      kind: "execution",
      user: "修复登录回归并开始执行",
      expected: "4. Act or Execute: use project_create/workspace_* directly for local folders"
    },
    {
      kind: "automation",
      user: "每天巡检失败的 Run，需要我时通知我",
      expected: "5. Automate: distinguish a one-time schedule or completion watch from a recurring Automation/Standing Order"
    }
  ] as const;

  async function withRuntimePrompt(name: string, assertion: (prompt: string) => void): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), `xuanwu-bun-supervisor-${name}-`));
    const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
    try {
      assertion(buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: `conv-${name}`,
        promptProfile: "chat",
        project: projectRecord("/tmp/xuanwu-prompt-project")
      }, db));
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  function estimatedTokens(prompt: string): number {
    return Math.ceil(prompt.length / 4);
  }

  function agentRecord() {
    return {
      id: "runner-default", name: "Xuanwu Supervisor", provider: "pi-sdk", model_provider: "pi-tools", model_id: "faux-1",
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
  return { trackDatabase, DECISION_FIXTURES, withRuntimePrompt, estimatedTokens, agentRecord, projectRecord };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
