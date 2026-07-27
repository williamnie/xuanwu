import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import {
  buildPiRuntimeSystemPrompt,
  xuanwuSupervisorCompatibilityPrompt,
  xuanwuSupervisorRoleContractPrompt
} from "./piRuntimePrompt.ts";

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
    expected: "4. Execute: for a concrete engineering outcome, resolve the project and Work scope"
  },
  {
    kind: "automation",
    user: "每天巡检失败的 Run，需要我时通知我",
    expected: "5. Automate: distinguish a one-time schedule or completion watch from a recurring Automation/Standing Order"
  }
] as const;

describe("Xuanwu Supervisor runtime prompt", () => {
  test("snapshots the canonical role and compatibility contracts", () => {
    expect([
      "[ROLE CONTRACT]",
      xuanwuSupervisorRoleContractPrompt(),
      "[COMPATIBILITY CONTRACT]",
      xuanwuSupervisorCompatibilityPrompt()
    ].join("\n\n")).toMatchSnapshot();
  });

  test("defines the Engineering Chief of Staff role, vocabulary, language, and deterministic gates", () => {
    const prompt = xuanwuSupervisorRoleContractPrompt();

    expect(prompt).toContain("Xuanwu Supervisor");
    expect(prompt).toContain("Engineering Chief of Staff");
    for (const term of ["Work", "Run", "Workflow", "Evidence", "Handoff", "Attention", "Automation"]) {
      expect(prompt).toContain(term);
    }
    expect(prompt).toContain("current system-language contract");
    expect(prompt).toContain("every state mutation, external write, and destructive action");
    expect(prompt).toContain("deterministic tool permission/approval gate");
    expect(prompt).toContain("cannot select the source of truth");
    expect(prompt).toContain("a successful Run is only a candidate result");
  });

  for (const fixture of DECISION_FIXTURES) {
    test(`covers the ${fixture.kind} decision fixture: ${fixture.user}`, () => {
      expect(xuanwuSupervisorRoleContractPrompt()).toContain(fixture.expected);
    });
  }

  test("keeps legacy tools as bounded compatibility adapters instead of the Supervisor identity", async () => {
    await withRuntimePrompt("compatibility", (prompt) => {
      expect(prompt).toContain("Compatibility prompt (temporary adapter, not a second product model)");
      expect(prompt).toContain("issues/issue_events and existing issue_* actions remain the authoritative write path");
      expect(prompt).toContain("issue_runs is the Run lifecycle authority");
      expect(prompt).toContain("issue_events handoff.* records are the Handoff projection");
      expect(prompt).toContain("This prompt introduces no dual write or dual read");
      expect(prompt).toContain("prefer the registered work_*, run_*, evidence_*, and handoff_* domain tools");
      expect(prompt).toContain("issue_create_proposal");
      expect(prompt).toContain("issue_enqueue_proposal");
      expect(prompt).toContain("issue_schedule_enqueue");
      expect(prompt).toContain("issue_enqueue_next_triage");
      expect(prompt).toContain("issue_enqueue_batch_triage");
      expect(prompt).toContain("issue_completion_watch_create");
      expect(prompt).toContain("Use depends_on_issue_ids only for success dependencies");
      expect(prompt).toContain("rollback verification, incident review, cleanup, or a final report");
      expect(prompt).toContain("Never combine depends_on_issue_ids with acceptance text that says the Work must proceed when that dependency fails");
    });
  });

  test("keeps investigation, repo proposal, memory, and repair boundaries", async () => {
    await withRuntimePrompt("boundaries", (prompt) => {
      expect(prompt).toContain("Manual context trigger workflow:");
      expect(prompt).toContain("manual_context_intake only fetches and persists a bounded context bundle");
      expect(prompt).toContain("You must interpret it and choose any follow-up tool");
      expect(prompt).toContain("Automatic reusable memory policy");
      expect(prompt).toContain("memory_remember");
      expect(prompt).toContain("Never store current or historical Work/Run/Issue status");
      expect(prompt).toContain("Repo-aware issue proposal workflow:");
      expect(prompt).toContain("repo_context_pack");
      expect(prompt).toContain("must not edit code");
      expect(prompt).toContain("issue_state_repair_proposal is only for deterministic");
      expect(prompt).toContain("最多追问一个关键问题");
      expect(prompt).toContain("Supervisor commitment context (operational projection, not long-term memory)");
      expect(prompt).toContain("xw.supervisor-commitment.v1");
      expect(prompt).toContain("never call memory_remember for a temporary commitment");
    });
  });

  test("keeps confirmed project/global memory scoped away from an old conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-supervisor-memory-"));
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      createPiMemoryItem(db, {
        content: "Project-level Supervisor preference",
        id: "supervisor-project-memory",
        kind: "preference",
        scope: "project",
        scope_id: "demo"
      });
      createPiMemoryItem(db, {
        content: "Global Supervisor behavior",
        id: "supervisor-global-memory",
        kind: "constraint",
        scope: "global"
      });
      createPiMemoryItem(db, {
        content: "Old chat conversation memory",
        id: "supervisor-old-conversation-memory",
        kind: "conversation_note",
        scope: "conversation",
        scope_id: "feishu-chat-old"
      });

      const prompt = buildPiRuntimeSystemPrompt({
        agent: agentRecord(),
        conversationID: "feishu-chat-new",
        project: projectRecord("/tmp/xuanwu-prompt-project")
      }, db);

      expect(prompt).toContain("Reusable Supervisor memory (non-authoritative context):");
      expect(prompt).toContain("Project-level Supervisor preference");
      expect(prompt).toContain("Global Supervisor behavior");
      expect(prompt).not.toContain("Old chat conversation memory");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the static and assembled prompt inside the token-size baseline", async () => {
    const role = xuanwuSupervisorRoleContractPrompt();
    await withRuntimePrompt("token-size", (prompt) => {
      const benchmark = {
        assembled_chars: prompt.length,
        assembled_estimated_tokens: estimatedTokens(prompt),
        role_chars: role.length,
        role_estimated_tokens: estimatedTokens(role)
      };

      expect(benchmark).toMatchSnapshot();
      expect(benchmark.role_estimated_tokens).toBeLessThanOrEqual(1_000);
      expect(benchmark.assembled_estimated_tokens).toBeLessThanOrEqual(6_000);
    });
  });
});

async function withRuntimePrompt(name: string, assertion: (prompt: string) => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `codex-runner-bun-supervisor-${name}-`));
  const db = await openDatabase({ stateDir: join(root, "state") });
  try {
    assertion(buildPiRuntimeSystemPrompt({
      agent: agentRecord(),
      conversationID: `conv-${name}`,
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
