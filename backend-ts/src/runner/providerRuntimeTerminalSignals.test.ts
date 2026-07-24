import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActions, listPiGuardianEvents, upsertProjectPiPolicy } from "../db/repositories/pi.ts";
import { runGuardianDecisionOrchestratorOnce } from "../pi/guardianDecisionOrchestrator.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("provider runtime terminal PI signals", () => {
  test("signals Guardian when provider emits a terminal runtime error during an open run", async () => {
    const db = await openFixtureDatabase();
    try {
      seedIssue(db, 527);

      await runIssueWithProvider(new RuntimeErrorProvider(), {
        database: db,
        issueId: 527,
        projectId: "demo",
        cwd: "/tmp/project",
        prompt: "issue prompt"
      });

      const signal = listPiGuardianEvents(db, { issueId: 527, status: "pending" })[0];
      expect(signal).toMatchObject({
        event_type: "guardian.supervisor.candidate",
        issue_id: 527,
        project_id: "demo",
        severity: "watch",
        source: "supervisor"
      });
      expect(JSON.parse(signal?.normalized_payload_json ?? "{}")).toMatchObject({
        allowed_actions: expect.arrayContaining(["session.resume_followup"]),
        diagnosis_code: "provider_rate_limited",
        provider_error_category: "rate_limit",
        provider_session_id: "thread-overloaded",
        provider_turn_id: "turn-overloaded",
        supervisor_mode: "autonomous"
      });

      const now = new Date("2026-06-22T15:40:40Z");
      runGuardianDecisionOrchestratorOnce(db, { now });
      runGuardianDecisionOrchestratorOnce(db, { now: new Date(now.getTime() + 31_000) });
      expect(listPiActions(db, { issueId: 527 })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-runtime-terminal-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedIssue(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    ["demo", "demo", "/tmp/demo", "codex", "2026-06-22T15:00:00Z", "2026-06-22T15:00:00Z"]
  );
  upsertProjectPiPolicy(db, { project_id: "demo", supervisor_mode: "off", allowed_supervisor_actions_json: [] });
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [issueID, "demo", "Runtime", "in_progress", "2026-06-22T15:00:00Z", "2026-06-22T15:00:00Z"]
  );
}

class RuntimeErrorProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly id = "codex" as const;
  async run(input: ProviderRunInput) {
    const session = { provider: this.id, sessionId: "thread-overloaded", turnId: "turn-overloaded" } as const;
    input.onEvent?.({ provider: this.id, raw: { method: "turn/started" }, session, status: "inProgress", type: "turn_started" });
    input.onEvent?.({
      error: "Selected model is at capacity. Please try a different model.",
      provider: this.id,
      raw: {
        method: "error",
        payload: JSON.stringify({
          error: { codexErrorInfo: "serverOverloaded", message: "Selected model is at capacity. Please try a different model." },
          willRetry: false
        })
      },
      session,
      status: "failed",
      type: "error"
    });
    return { runId: "codex:thread-overloaded:turn-overloaded", session };
  }
}
