import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";

import type {
  ExecutorProvider,
  ProviderRunInput,
  SessionMessageInput
} from "../../providers/types.ts";

import { useDatabaseCleanup } from "../../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

export class RevisionProvider implements ExecutorProvider {
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  readonly id = "codex" as const;
  readonly messages: SessionMessageInput[] = [];

  async run(_input: ProviderRunInput) {
    return { runId: "unused" };
  }

  async sendSessionMessage(input: SessionMessageInput) {
    this.messages.push(input);
    return {
      provider: this.id,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "turn-revision"
    };
  }
}

export class FailingRevisionProvider extends RevisionProvider {
  override async sendSessionMessage(_input: SessionMessageInput): Promise<never> {
    throw new Error("resume unavailable");
  }
}

export async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "human-review-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, sort_order, created_at, updated_at)
     values ('demo', 'demo', ?, 'codex', 0, 1, ?, ?)`,
    [root, "2026-07-31T00:00:00Z", "2026-07-31T00:00:00Z"]
  );
  return db;
}
