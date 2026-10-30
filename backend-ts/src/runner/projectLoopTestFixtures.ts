import { afterEach } from "bun:test";

import type { SQLQueryBindings } from "bun:sqlite";
import { type RunnerDatabase } from "../db/database.ts";

import { runProjectLoopOnce } from "./projectLoop.ts";
import { setProjectLoopMaxParallelProjects } from "./projectLoopManager.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderEvent, ProviderRunInput, ProviderRunResult } from "../providers/types.ts";
import { FIXTURE_TIME, insertIssue, insertProject, insertRow, useTestDatabase, waitFor } from "../testing/harness.ts";

export type ScriptedEvent = Omit<ProviderEvent, "provider" | "session">;

export const STARTED: ScriptedEvent = { type: "provider.message", text: "fake started" };

export const TURN_STARTED: ScriptedEvent = { status: "running", type: "turn_started" };

export const DONE: ScriptedEvent = { raw: { method: "turn/completed" }, status: "completed", type: "done" };

export const FAKE = "fake-execution-only" as ExecutorProviderId;

export class ScriptedProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution"] as const;
  readonly inputs: ProviderRunInput[] = [];
  private readonly emitters = new Map<number, (event: ScriptedEvent) => void>();

  constructor(
    readonly id: ExecutorProviderId = FAKE,
    private readonly script: { events?: readonly ScriptedEvent[]; fail?: string } = {}
  ) {}

  async run(input: ProviderRunInput): Promise<ProviderRunResult> {
    this.inputs.push(input);
    if (this.script.fail) throw new Error(this.script.fail);
    const prefix = this.id === FAKE ? "fake" : this.id;
    const session = { provider: this.id, sessionId: `${prefix}-session-${input.issueId}`, turnId: `${prefix}-turn-${input.issueId}` };
    const emit = (event: ScriptedEvent) => input.onEvent?.({ ...event, provider: this.id, session });
    this.emitters.set(input.issueId, emit);
    for (const event of this.script.events ?? [STARTED]) emit(event);
    return { runId: `${prefix}-run-${input.issueId}`, session };
  }

  /** Emits a later provider event on the run of `issueID`. */
  emit(issueID: number, event: ScriptedEvent): void {
    const emit = this.emitters.get(issueID);
    if (!emit) throw new Error(`no run for issue ${issueID}`);
    emit(event);
  }
}

export const openFixtureDatabase = useTestDatabase("xuanwu-bun-project-loop-");

afterEach(() => {
  setProjectLoopMaxParallelProjects(1);
});

export const PROVIDER_FAILURE = "provider failed CODEX_API_KEY=fixture-secret";

export const INITIALIZE_TIMEOUT = "codex app-server request timed out after 10000ms: initialize";

export function addProject(db: RunnerDatabase, id: string, provider: string, values: Record<string, SQLQueryBindings> = {}): void {
  insertProject(db, id, { provider, model: "codex-default", ...values });
}

export function addIssue(db: RunnerDatabase, projectId: string, title: string, values: Record<string, SQLQueryBindings> = {}): number {
  const createdAt = values.created_at ?? FIXTURE_TIME;
  return insertIssue(db, { project_id: projectId, title, status: "todo", updated_at: createdAt, ...values });
}

export function insertAgentProfile(db: RunnerDatabase, id: string, provider: string, values: Record<string, SQLQueryBindings>): void {
  insertRow(db, "agent_profiles", {
    id, name: id, provider, reasoning_effort: "high", approval_policy: "on-request", sandbox: "danger-full-access",
    skill_intents_json: "[]", created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME, ...values
  });
}

export function runOnce(db: RunnerDatabase, provider: ScriptedProvider, projectId = "demo") {
  return runProjectLoopOnce({ database: db, projectId, providers: { [provider.id]: provider } });
}

export async function promptFor(
  issue: Record<string, SQLQueryBindings> & { title: string },
  seed: (db: RunnerDatabase, issueID: number) => void = () => {}
): Promise<string> {
  const db = await openFixtureDatabase();
  const provider = new ScriptedProvider();
  addProject(db, "demo", provider.id);
  seed(db, addIssue(db, "demo", issue.title, issue));
  await runOnce(db, provider);
  return provider.inputs[0]?.prompt ?? "";
}

export function resolvedSettings(overrides: Record<string, string>) {
  return {
    approval_policy: "never", model: "", reasoning_effort: "", sandbox: "workspace-write",
    service_tier: "", service_tier_source: "standard", ...overrides
  };
}

export function settle(predicate: () => boolean): Promise<unknown> {
  return waitFor(predicate, "condition timed out", 100, 5);
}

export function latestRunMetadata(db: RunnerDatabase, issueId: number): Record<string, unknown> {
  const row = db.sqlite.query<{ runtime_metadata_json: string }, [number]>(
    `select runtime_metadata_json from issue_runs where issue_id=? order by attempt desc limit 1`
  ).get(issueId);
  return JSON.parse(row?.runtime_metadata_json || "{}") as Record<string, unknown>;
}

export function latestRun(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(
    `select agent_profile_id, capability_summary, selection_reason
     from issue_runs where issue_id=? order by attempt desc limit 1`
  ).get(issueId);
}

export function latestAttempt(db: RunnerDatabase, issueId: number): Record<string, unknown> | null {
  return db.sqlite.query<Record<string, unknown>, [number]>(`
    select a.provider, a.provider_session_id, a.provider_turn_id
    from run_attempts a join issue_runs r on r.id=a.issue_run_id
    where r.issue_id=? order by a.sequence desc limit 1
  `).get(issueId);
}

export function insertOpenRun(db: RunnerDatabase, issueID: number): void {
  insertRow(db, "issue_runs", { id: `issue-${issueID}-attempt-1`, issue_id: issueID, attempt: 1, status: "in_progress", started_at: FIXTURE_TIME });
}

export function closeClaimedIssue(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run("update issues set status='done' where id=?", [issueID]);
  db.sqlite.run("update issue_runs set status='done', ended_at=? where issue_id=? and ended_at=''", ["2026-01-01T00:01:00Z", issueID]);
}

export function listEventTypes(db: RunnerDatabase, issueID: number): string[] {
  return db.sqlite.query<{ type: string }, [number]>(
    "select type from issue_events where issue_id=? order by id asc"
  ).all(issueID).map((event) => event.type);
}

export function latestEventPayload(db: RunnerDatabase, issueID: number, type: string): Record<string, unknown> {
  const payload = db.sqlite.query<{ payload: string }, [number, string]>(
    "select payload from issue_events where issue_id=? and type=? order by id desc limit 1"
  ).get(issueID, type)?.payload ?? "{}";
  return JSON.parse(payload) as Record<string, unknown>;
}
