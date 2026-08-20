import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { recordIssueLogEvent, RUNTIME_EVIDENCE_CORRELATION_CONTRACT } from "../../db/repositories/issueEvents.ts";
import { createIssueRun, insertIssueRunRecord, updateIssueRuntime } from "../../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../run/runPreparation.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  assertCompletionCardIntegrity,
  buildIssueCompletionCard,
  recordCompletionGitObservation
} from "./completionCard.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("completion card", () => {
  test("preserves chronological early failure and later full success without classifying command text", async () => {
    const root = await mkdtemp(join(tmpdir(), "completion-card-"));
    roots.push(root);
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    await writeFile(join(root, "README.md"), "base\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "base");
    const db = await openDatabase({ stateDir: join(root, ".state") });
    try {
      db.sqlite.run(
        `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
         values ('demo', 'Demo', ?, 'codex', 1, ?, ?)`,
        [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
      );
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Node contract" });
      const prepared = await prepareReservedIssueRun(db, insertIssueRunRecord(db, issue.id));
      if (prepared.status !== "ready") throw new Error("Run preparation failed");
      const run = prepared.run;
      updateIssueRuntime(db, issue.id, {
        issue_run_id: run.id,
        provider: "codex",
        provider_session_id: "thread-card",
        provider_turn_id: "turn-card"
      });
      const domainRunID = makeDomainID("run", "issue_runs", run.id);
      const correlation = {
        attempt_id: makeRunAttemptID(domainRunID, run.attempt),
        contract: RUNTIME_EVIDENCE_CORRELATION_CONTRACT,
        issue_run_id: run.id,
        provider: "codex",
        provider_session_id: "thread-card",
        provider_turn_id: "turn-card",
        run_id: domainRunID
      };
      recordIssueLogEvent(db, issue.id, commandEvent("early", "node --version; pnpm test", 1, "Node 24 engine mismatch"), correlation);
      recordIssueLogEvent(db, issue.id, normalizedCommandEvent(
        "final",
        "export PATH=/node22/bin:$PATH; pnpm --filter @demo/contract generate && pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check",
        0,
        "74 tests passed\nbuild completed"
      ), correlation);
      recordIssueLogEvent(db, issue.id, {
        provider: "codex",
        session: { provider: "codex", sessionId: "thread-card", turnId: "turn-card" },
        text: "Node 22 下完整验证通过。\nRUNNER_OUTCOME: completed",
        type: "raw",
        raw: {
          method: "item/completed",
          payload: JSON.stringify({ item: { id: "final-message", type: "agentMessage", text: "Node 22 下完整验证通过。" } })
        }
      }, correlation);
      await writeFile(join(root, "contract.ts"), "export const node = 22;\n");
      git(root, "add", "contract.ts");
      git(root, "commit", "-m", "feat: add contract");
      const endedAt = new Date(Date.now() + 1_000).toISOString();
      db.sqlite.run("update issue_runs set status='done', ended_at=? where id=?", [endedAt, run.id]);
      await writeFile(join(root, "uncommitted.txt"), "terminal workspace change\n");
      recordCompletionGitObservation(db, {
        issue_id: issue.id,
        observed_at: endedAt,
        repository: root,
        run: { ...run, ended_at: endedAt, status: "done" }
      });

      const card = await buildIssueCompletionCard(db, issue.id);
      expect(card.commands.items.map((item) => ({ command: item.command, exit: item.exit_code }))).toEqual([
        { command: "node --version; pnpm test", exit: 1 },
        {
          command: "export PATH=/node22/bin:$PATH; pnpm --filter @demo/contract generate && pnpm lint && pnpm typecheck && pnpm test && pnpm build && git diff --check",
          exit: 0
        }
      ]);
      expect(card.final_message).toContain("RUNNER_OUTCOME: completed");
      expect(card.git.changed_files).toContain("contract.ts");
      expect(card.git.changed_files).toContain("uncommitted.txt");
      expect(card.git.has_diff).toBe(true);
      expect(card.git).toMatchObject({ source: "terminal_observation", working_tree_dirty: true });
      expect(card.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(() => assertCompletionCardIntegrity(card)).not.toThrow();
      const tampered = structuredClone(card);
      tampered.commands.items[1]!.exit_code = 1;
      expect(() => assertCompletionCardIntegrity(tampered)).toThrow("fingerprint does not match");
    } finally {
      db.close();
    }
  });

  test("falls back to the live workspace instead of reporting a false clean tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "completion-card-live-fallback-"));
    roots.push(root);
    git(root, "init");
    git(root, "config", "user.email", "test@example.com");
    git(root, "config", "user.name", "Test");
    await writeFile(join(root, "README.md"), "base\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "base");
    const db = await openDatabase({ stateDir: join(root, ".state") });
    try {
      db.sqlite.run(
        `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
         values ('demo', 'Demo', ?, 'pi-coding-agent', 1, ?, ?)`,
        [root, "2026-07-31T05:00:00Z", "2026-07-31T05:00:00Z"]
      );
      const issue = createIssue(db, { project_id: "demo", status: "in_progress", title: "Pi fallback" });
      const run = createIssueRun(db, issue.id);
      await writeFile(join(root, "pi-change.ts"), "export const changed = true;\n");
      const endedAt = new Date().toISOString();
      db.sqlite.run("update issue_runs set status='failed', ended_at=?, error=? where id=?", [endedAt, "idle timeout", run.id]);

      const card = await buildIssueCompletionCard(db, issue.id);

      expect(card.git).toMatchObject({
        has_diff: true,
        source: "session_observation",
        working_tree_dirty: true
      });
      expect(card.git.changed_files).toContain("pi-change.ts");
    } finally {
      db.close();
    }
  });
});

function commandEvent(id: string, command: string, exitCode: number, aggregatedOutput: string) {
  return {
    command,
    provider: "codex" as const,
    session: { provider: "codex" as const, sessionId: "thread-card", turnId: "turn-card" },
    status: exitCode === 0 ? "completed" : "failed",
    type: "tool",
    raw: {
      method: "item/completed",
      payload: JSON.stringify({
        item: { aggregatedOutput, command, cwd: ".", exitCode, id, status: exitCode === 0 ? "completed" : "failed", type: "commandExecution" }
      })
    }
  };
}

function normalizedCommandEvent(id: string, command: string, exitCode: number, output: string) {
  return {
    command,
    payload: {
      cwd: ".",
      duration_ms: 120,
      exit_code: exitCode,
      item_id: id,
      item_type: "commandExecution",
      output_excerpt: output,
      raw_payload_omitted: true,
      representation: "terminal_tool_observation",
      schema_version: "xw.tool-observation.v1"
    },
    provider: "codex" as const,
    session: { provider: "codex" as const, sessionId: "thread-card", turnId: "turn-card" },
    status: exitCode === 0 ? "completed" : "failed",
    text: output,
    type: "tool",
    raw: { method: "item/completed" }
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
