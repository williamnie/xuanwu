import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { EXECUTOR_PROVIDER_IDS, type ExecutorProvider, type ProviderRunInput, type ProviderRunResult } from "../types.ts";
import { CONFORMANCE_FIXTURES, ExecutionOnlyProvider, ResumableSessionProvider } from "./conformanceFixtures.ts";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDatabase(): Promise<RunnerDatabase> {
  const dir = await mkdtemp(join(tmpdir(), "p0-fixture-"));
  tempRoots.push(dir);
  return openDatabase({ dbPath: join(dir, "xuanwu.db") });
}

describe("P0 baseline: execution-only provider 形态", () => {
  test("不写 agent_sessions、不产出 session ref，仍可完成 Attempt", async () => {
    const db = await tempDatabase();
    try {
      insertProject(db, "p0-project");
      const issueId = insertIssue(db, "p0-project");
      const issueRunId = createIssueRun(db, issueId).id;
      const provider = new ExecutionOnlyProvider();
      const result = await runIssueWithProvider(provider, {
        issueId,
        issueRunId,
        projectId: "p0-project",
        cwd: "/tmp/p0",
        prompt: "run",
        database: db,
        onRunStart: () => {},
        onRunComplete: () => {}
      });
      expect(result).toMatchObject({ runId: `fake-execution-${issueId}` });
      expect(result.session).toBeUndefined();
      // execution-only 只声明 issue_execution
      expect(provider.capabilities).toEqual(["issue_execution"]);
      expect(provider.capabilities).not.toContain("sessions");
      expect(provider.capabilities).not.toContain("resume_session");
    } finally {
      db.close();
    }
  });
});

describe("P0 baseline: session-without-message-ref 形态", () => {
  test("resume 不需要上一 message/turn ref", async () => {
    const provider = new ResumableSessionProvider();
    const input = {
      issueId: 2,
      projectId: "p0-resumable",
      cwd: "/tmp/p0",
      prompt: "resume"
    };
    const first = await provider.run({ ...input, onEvent: () => {} });
    expect(first.session?.sessionId).toBe("fake-resumable-session-p0-resumable");
    expect(first.session?.turnId).toBeUndefined();

    const recovered = await provider.recover({
      ...input,
      session: { provider: "fake-resumable", sessionId: first.session!.sessionId },
      onEvent: () => {}
    });
    expect(recovered.session?.sessionId).toBe("fake-resumable-session-p0-resumable");
    expect(recovered.session?.turnId).toBeUndefined();
    expect(provider.runs).toHaveLength(2);
    expect(provider.runs[1].recovered).toBe(true);
  });
});

describe("P0 baseline: conformance fixtures 集合", () => {
  test("三类 fixture 覆盖 execution-only / session-without-message-ref / full-session", () => {
    const ids = Object.values(CONFORMANCE_FIXTURES).map((p) => p.id);
    expect(ids).toContain("fake-execution-only");
    expect(ids).toContain("fake-resumable");
    expect(ids).toContain("fake-full-session");
  });

  test("full-session fixture 声明全部 capability 且方法齐全", () => {
    const full = CONFORMANCE_FIXTURES.fullSession;
    expect(full.capabilities).toEqual(
      expect.arrayContaining(["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"])
    );
    for (const method of ["createSession", "interrupt", "listSessions", "readSession", "sendSessionMessage", "listModels"]) {
      expect(typeof (full as unknown as Record<string, unknown>)[method]).toBe("function");
    }
  });
});

describe("P0 baseline: 自动检测前后端 provider/capability drift", () => {
  const frontendSessionOptionsPath = resolve(import.meta.dir, "../../../../frontend/src/pages/sessions/sessionOptions.js");
  const frontendIssueRunsPath = resolve(import.meta.dir, "../../../../frontend/src/utils/issueRuns.js");

  test("前端可提交 provider option 均在后端 EXECUTOR_PROVIDER_IDS 内（未注册 provider 不得进入可提交 option）", async () => {
    const source = await readFile(frontendSessionOptionsPath, "utf8");
    // 只取 PROVIDER_OPTIONS 块内的 value/enabled 配对，避免误匹配其他 option 列表
    const providerBlock = source.match(/PROVIDER_OPTIONS\s*=\s*\[([\s\S]*?)\];/)?.[1] ?? "";
    expect(providerBlock.length).toBeGreaterThan(0);
    const enabledValues = [...providerBlock.matchAll(/value:\s*'([^']+)'/g)]
      .map((m, i) => {
        const after = providerBlock.slice(providerBlock.indexOf(m[0]) + m[0].length);
        const enabled = /enabled:\s*true/.test(after.slice(0, 80));
        return { value: m[1], enabled };
      })
      .filter((item) => item.enabled)
      .map((item) => item.value);
    expect(enabledValues.length).toBeGreaterThan(0);
    for (const value of enabledValues) {
      expect(EXECUTOR_PROVIDER_IDS as readonly string[]).toContain(value);
    }
    // 未启用占位（opencode/kimicode）不得出现在 enabled 集合
    expect(enabledValues).not.toContain("opencode");
    expect(enabledValues).not.toContain("kimicode");
  });

  test("前端 CAPABILITY_LABELS 与后端 ExecutorCapability 对齐（P6 后 transcript_export 由 nativeActions 提供）", async () => {
    const source = await readFile(frontendSessionOptionsPath, "utf8");
    const labelsBlock = source.match(/CAPABILITY_LABELS\s*=\s*{([^}]+)}/)?.[1] ?? "";
    const frontendCapabilities = [...labelsBlock.matchAll(/([a-z_]+):/g)].map((m) => m[1]).sort();
    expect(frontendCapabilities.length).toBeGreaterThan(0);
    // P6：transcript_export 不再是通用 capability label（后端 ExecutorCapability 亦无此项）
    expect(frontendCapabilities).not.toContain("transcript_export");
    const knownFrontendOnly = frontendCapabilities.filter((c) => !["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"].includes(c));
    expect(knownFrontendOnly).toEqual([]);
  });

  test("前端 issueRuns.js：P6 后静态 authority 删除，session 能力由 catalog capability 投影", async () => {
    const source = await readFile(frontendIssueRunsPath, "utf8");
    // P6：静态 SESSION_CAPABLE_PROVIDERS authority 已删除，改为 catalog 派生（fallback 命名仅兼容）
    expect(source).not.toMatch(/SESSION_CAPABLE_PROVIDERS\s*=\s*new Set\(\['codex', 'claude'\]\)/);
    expect(source).toMatch(/sessionCapableFromCatalog/);
    expect(source).toMatch(/isSessionCapableProvider/);
    // opencode/kimicode 不再进入 label switch（roadmap 只留文档）
    expect(source).not.toMatch(/case\s+'opencode'/);
    expect(source).not.toMatch(/case\s+'kimicode'/);
  });
});

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, issue_log_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, "P0 baseline", "in_progress", "debug", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
