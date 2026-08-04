import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { EventBus, type AppEvent } from "../events/bus.ts";
import { startProjectLoop } from "./projectLoopManager.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";

const tempRoots: string[] = [];

class BlockingStreamingProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  release: (() => void) | undefined;

  async run(input: ProviderRunInput) {
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      text: "live provider output",
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    });
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return {
      runId: `fake-run-${input.issueId}`,
      session: { provider: this.id, sessionId: `fake-session-${input.issueId}`, turnId: `fake-turn-${input.issueId}` }
    };
  }
}

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-realtime-events-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("project loop realtime issue log events", () => {
  test("publishes provider issue.log rows to the SSE event bus while the run is still active", async () => {
    const db = await openFixtureDatabase();
    const bus = new EventBus();
    const events = bus.subscribe();
    const provider = new BlockingStreamingProvider();
    try {
      insertProject(db, provider.id);
      const issueId = insertIssue(db);

      startProjectLoop({ database: db, providers: { [provider.id]: provider }, bus }, "demo");

      const event = await nextMatchingEvent(events, (item) => item.type === "issue.log");
      expect(event).toMatchObject({
        type: "issue.log",
        issueId,
        projectId: "demo"
      });
      expect(event?.payload).toContain("live provider output");
    } finally {
      provider.release?.();
      events.close();
      db.close();
    }
  });
});

async function nextMatchingEvent(
  events: ReturnType<EventBus["subscribe"]>,
  predicate: (event: AppEvent) => boolean,
  timeoutMs = 500
): Promise<AppEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = await Promise.race([
      events.next(),
      Bun.sleep(10).then(() => undefined)
    ]);
    if (event && predicate(event)) return event;
  }
  return undefined;
}

function insertProject(db: RunnerDatabase, provider: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", "/tmp/demo", provider, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, issue_log_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Realtime log", "todo", "debug", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
