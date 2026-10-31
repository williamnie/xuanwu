import { afterEach, expect, setDefaultTimeout } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueRuns } from "../db/repositories/issues.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";

import { applyPiSemanticIssueStatus } from "./piIssueLifecycle.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { isProjectLoopActive } from "./projectLoopManager.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";

export const roots: string[] = [];

setDefaultTimeout(30_000);

afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

export class Provider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  inputs: ProviderRunInput[] = [];
  messages: SessionMessageInput[] = [];
  async sendSessionMessage(input: SessionMessageInput) {
    this.messages.push(input);
    return { provider: this.id, sessionId: input.sessionId, turn_id: "revision-turn", provider_session_id: input.sessionId };
  }
  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    const session = { provider: this.id, sessionId: `session-${input.issueId}`, turnId: `turn-${input.issueId}` };
    input.onEvent?.({ provider: this.id, type: "done", status: "completed", session, raw: { method: "turn/completed" } });
    return { runId: `run-${input.issueId}`, session };
  }
}

export async function fixture(withRequest = true) {
  const root = await mkdtemp(join(tmpdir(), "workspace-wait-"));
  roots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "seed.txt"), "initial");
  git(cwd, "add", "seed.txt");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id,name,cwd,provider,auto_run,created_at,updated_at)
    values ('demo','demo',?,'codex',1,?,?)`, [cwd, new Date().toISOString(), new Date().toISOString()]);
  const provider = new Provider();
  const runtime = { database: db, providers: { codex: provider } };
  const issue = createIssue(db, { project_id: "demo", title: "需要产品决定", status: "todo" });
  await runProjectLoopOnce({ ...runtime, projectId: "demo" });
  applyPiSemanticIssueStatus(db, issue.id, { card_fingerprint: "fixture", decision: "needs_user",
    reason: "需要产品决定", run_id: listIssueRuns(db, issue.id).at(-1)!.id, status: "needs_user" });
  const request = withRequest ? createHumanReviewRequest(db, issue.id, { kind: "decision", question: "是否继续？" }) : null;
  return { root, cwd, db, provider, runtime, issue, request };
}

export function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

export async function drain(db: RunnerDatabase) {
  const deadline = Date.now() + 15_000;
  while (isProjectLoopActive("demo", db) && Date.now() < deadline) await Bun.sleep(10);
  expect(isProjectLoopActive("demo", db)).toBe(false);
}

export function answer(f: Awaited<ReturnType<typeof fixture>>, action = "accept") {
  const request = f.request!;
  return { action, comment: "确认当前范围", review_request_id: request.id, review_revision: request.revision };
}
