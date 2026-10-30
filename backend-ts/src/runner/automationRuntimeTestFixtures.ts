import { afterEach } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";

import { createAutomation } from "../db/repositories/automations.ts";

import { createIssue } from "../db/repositories/issueCreate.ts";

import { createPiConversation } from "../db/repositories/pi.ts";

import { createSupervisorCommitment } from "../pi/supervisor/supervisorCommitments.ts";
import type { ExecutorProvider, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { INVESTIGATE_WORKFLOW_REF } from "../workflows/investigate.ts";
import { runScheduleLayerCycle } from "./piAutoManageScheduler.ts";
import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const roots: string[] = [];

export const NOW = new Date("2026-07-18T10:00:00.000Z");

export class FixtureProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];

  constructor(private failuresRemaining = 0) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("fixture provider unavailable");
    }
    return { runId: `fixture-run-${this.inputs.length}` };
  }
}

export class FixtureClock {
  timers: Array<{ callback: () => void; cancelled: boolean }> = [];

  clearTimeout(timer: { cancelled: boolean }): void {
    timer.cancelled = true;
  }

  setTimeout(callback: () => void) {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  runNext(): void {
    const timer = this.timers.shift();
    if (timer && !timer.cancelled) timer.callback();
  }
}

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

export async function cycle(db: RunnerDatabase, provider: FixtureProvider, now: Date) {
  return runScheduleLayerCycle({
    database: db,
    providers: { [provider.id]: provider },
    runProjectCycle: async () => ({}),
    runSupervisor: false,
    watchdogNow: now
  });
}

export async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "automation-runtime-"));
  roots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  insertProject(db, "demo", cwd);
  return db;
}

export function createFixture(
  db: RunnerDatabase,
  suffix: string,
  mode: "execute_allowed" | "observe",
  options: { commitment?: boolean; projectID?: string } = {}
) {
  const projectID = options.projectID ?? "demo";
  if (options.commitment !== false) createCommitmentFixture(db, projectID, suffix);
  return createAutomation(db, {
    id: `automation:${suffix}`,
    idempotency_namespace: `automation:${suffix}`,
    mode,
    name: `Automation ${suffix}`,
    next_run_at: "2026-07-18T09:59:30.000Z",
    owner: { kind: "project", project_id: projectID },
    permission_policy_ref: `project-policy:${projectID}`,
    status: "active",
    workflow_ref: INVESTIGATE_WORKFLOW_REF,
    trigger_created_by: "system",
    trigger: { type: "continuous", config: { poll_interval_seconds: 60 } }
  }, "2026-07-18T09:00:00.000Z");
}

export function createCommitmentFixture(db: RunnerDatabase, projectID: string, suffix: string): void {
  const conversationID = `standing-order-${projectID}-${suffix}`;
  createPiConversation(db, { id: conversationID, pi_agent_id: "fixture-agent", project_id: projectID, title: suffix });
  const issue = createIssue(db, {
    description: `Standing Order context ${suffix}`,
    project_id: projectID,
    status: "in_progress",
    title: `Commitment ${suffix}`
  });
  createSupervisorCommitment(db, {
    condition: { commitment: { schema_version: "xw.supervisor-commitment.v1" } },
    issue_ids: [issue.id],
    origin_conversation_id: conversationID,
    project_id: projectID,
    requested_by: "fixture-user",
    source_event_id: `standing-order-source-${projectID}-${suffix}`
  });
}

export function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values (?, ?, ?, 'fake-execution-only', ?, ?)`, [id, id, cwd, NOW.toISOString(), NOW.toISOString()]);
}

export function stateDirFor(db: RunnerDatabase): string {
  const row = db.sqlite.query<{ file: string }, []>("pragma database_list").all()
    .find((item) => item.file.endsWith("runner.db"));
  return row?.file.slice(0, -"/runner.db".length) ?? "";
}

export async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
