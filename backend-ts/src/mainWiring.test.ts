import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("server entrypoint wiring", () => {
  test("passes executor providers into Feishu PI conversations", () => {
    const source = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");

    expect(source).toContain("runPiConversationPrompt({ bus, database, providers }");
  });
  test("uses a stable Feishu chat/thread conversation id instead of per-message ids", () => {
    const source = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");

    expect(source).toContain("runConversation: async ({ conversationId, event, projectId, prompt, targetIssueId, targetProjectId, targetProjectSource })");
    expect(source).toContain("conversationId,");
    expect(source).toContain("targetProjectSource,");
    expect(source).toContain("channelContext: buildFeishuConversationPromptContext(database, { event })");
    expect(source).not.toContain("continuation?.issueId");
    expect(source).not.toContain("feishuConversationID");
    expect(source).not.toContain("event.thread_id || event.root_id || event.chat_id || event.message_id");
  });

  test("loads Web, Core, and Agentic runtime graphs only after selecting a role", () => {
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

    expect(source).toContain('await import("./runtime/web.ts")');
    expect(source).toContain('await import("./runtime/core.ts")');
    expect(source).toContain('await import("./runtime/agentic.ts")');
    expect(source).not.toContain('from "./db/database.ts"');
    expect(source).not.toContain('from "./providers/');
  });

  test("keeps automatic LLM boundaries behind the Agentic Worker client in split mode", () => {
    const core = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");

    expect(core).toContain("createHttpAgenticWorkerClient");
    expect(core).toContain("agenticClient.runProjectCycle");
    expect(core).toContain("agenticClient.decideCommunication");
    expect(core).toContain("agenticClient.decideSupervisor");
    expect(core).not.toContain('from "../http/piProjectControlApi.ts"');
  });

  test("uses non-suspending physical memory and lifecycle-owned descendants off the Core HTTP loop", () => {
    const core = readFileSync(join(import.meta.dir, "runtime", "core.ts"), "utf8");
    const darwinMemory = readFileSync(join(import.meta.dir, "observability", "darwinProcessMemory.ts"), "utf8");

    expect(core).toContain("inspect: () => runtimeMemoryRows(runtimeStartedAt, providerRuntime(), agenticClient.activity())");
    expect(core).toContain("agenticActivity: agenticClient.activity");
    expect(core).toContain("reclaimMemory: () => Bun.gc(true)");
    expect(core).toContain("runWithinActivity: (operation) => processGroupMemory.runMaintenance(operation)");
    expect(core).toContain("ownership.processes.map");
    expect(core).toContain("codex-issue-runner-agentic");
    expect(core).not.toContain("Bun.spawnSync");
    expect(core).not.toContain("/usr/bin/footprint");
    expect(darwinMemory).toContain("proc_pid_rusage");
    expect(darwinMemory).not.toContain("Bun.spawn");
  });

});
