import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import {
  createPiMemoryItem,
  getPiMemoryItem,
  listPiActionEvents,
  listPiActions,
  listPiMemoryItems,
  listPiMemoryHistory,
  rememberPiMemoryItem,
  updatePiMemoryItem,
  deletePiMemoryItem
} from "../../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-memory-tools-"));
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

export function toolByName(tools: ReturnType<typeof createPiMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

export function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}

export function seedMemory(db: RunnerDatabase, item: {
  content: string; id: string; kind: string; scope: string; scope_id: string;
}) {
  return createPiMemoryItem(db, {
    ...item,
    confidence: "high",
    disabled: 0
  });
}

export function seedProjectPolicyFixture(db: RunnerDatabase): void {
  seedMemory(db, policyMemory("project-policy-memory", "demo",
    "Prefer verification evidence before marking runner issues done"));
  seedMemory(db, {
    id: "global-user-preference",
    scope: "global",
    scope_id: "runner",
    kind: "user_preference",
    content: "Prefer concise Chinese progress updates"
  });
  seedMemory(db, {
    id: "global-policy-memory",
    scope: "global",
    scope_id: "runner",
    kind: "project_policy_memory",
    content: "Prefer runner-level housekeeping"
  });
  seedMemory(db, policyMemory("other-project-memory", "other", "Prefer broad refactors"));
  seedMemory(db, policyMemory("sensitive-memory", "demo", "XUANWU_AUTH_TOKEN=fixture-secret"));
  seedMemory(db, {
    id: "stale-issue-status",
    scope: "project",
    scope_id: "demo",
    kind: "decision",
    content: "当前 Issue #785 failed，等待人工处理。"
  });
}

export function policyMemory(id: string, scopeID: string, content: string) {
  return { id, scope: "project", scope_id: scopeID, kind: "project_policy_memory", content };
}

export function itemIds(details: unknown): string[] {
  const items = (details as { items?: Array<{ id: string }> }).items ?? [];
  return items.map((item) => item.id).sort();
}

export async function concurrentRemember(root: string, dbPath: string, inputs: Record<string, unknown>[]): Promise<Record<string, any>[]> {
  const prefix = join(root, crypto.randomUUID());
  const worker = `${prefix}.ts`;
  await Bun.write(worker, `
    import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "../../db/database.ts"))};
    import { createPiMemoryTools } from ${JSON.stringify(join(import.meta.dir, "memoryTools.ts"))};
    const [dbPath, prefix, index, payload] = process.argv.slice(2);
    const db = await openDatabase({ dbPath, writerBusyTimeoutMs: 10000 });
    try {
      await Bun.write(prefix + '.' + index + '.ready', 'ready');
      while (!await Bun.file(prefix + '.start').exists()) await new Promise(resolve => setTimeout(resolve, 5));
      const remember = createPiMemoryTools(db, { projectID: 'demo', source: 'pi_manager_cycle' }).find(tool => tool.name === 'memory_remember');
      const result = await remember.execute('concurrent', JSON.parse(payload), undefined, undefined, {});
      await Bun.write(prefix + '.' + index + '.result', JSON.stringify(result.details));
    } finally { db.close(); }
  `);
  const children = inputs.map((input, i) => Bun.spawn({
    cmd: [process.execPath, worker, dbPath, prefix, String(i), JSON.stringify(input)], stdout: "pipe", stderr: "pipe"
  }));
  try {
    const deadline = Date.now() + 15000;
    while (!(await Promise.all(inputs.map((_, i) => Bun.file(`${prefix}.${i}.ready`).exists()))).every(Boolean)) {
      if (Date.now() > deadline) throw new Error("memory worker startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Bun.write(`${prefix}.start`, "start");
    const exits = await Promise.all(children.map(async (child) => ({
      code: await child.exited, stderr: await new Response(child.stderr).text()
    })));
    for (const exit of exits) expect(exit.code, exit.stderr).toBe(0);
    return Promise.all(inputs.map((_, i) => Bun.file(`${prefix}.${i}.result`).json()));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}
