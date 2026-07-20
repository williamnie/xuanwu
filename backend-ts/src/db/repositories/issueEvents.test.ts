import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { listAttentionInboxItems } from "./intakeRuns.ts";
import { parseIssueEventProviderError } from "../../pi/providerErrorParser.ts";
import {
  ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES,
  ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES,
  latestIssueEventsByIssueID,
  listIssueEvents,
  recordIssueLogEvent
} from "./issueEvents.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-events-repo-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue event repository logs", () => {
  test("loads the latest typed event for many Issues in one batch", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const first = insertIssue(database, "demo");
      const second = insertIssue(database, "demo");
      database.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.created', ?, ?)",
        [first, JSON.stringify({ version: 1 }), "2026-01-01T00:00:01Z"]
      );
      database.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.created', ?, ?)",
        [first, JSON.stringify({ version: 2 }), "2026-01-01T00:00:02Z"]
      );
      database.sqlite.run(
        "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.created', ?, ?)",
        [second, JSON.stringify({ version: 3 }), "2026-01-01T00:00:03Z"]
      );

      const events = latestIssueEventsByIssueID(database, [first, second], "issue.created");

      expect(JSON.parse(events.get(first)?.payload ?? "{}")).toEqual({ version: 2 });
      expect(JSON.parse(events.get(second)?.payload ?? "{}")).toEqual({ version: 3 });
    } finally {
      database.close();
    }
  });

  test("records normalized provider error events as issue.log rows", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");

      const event = recordIssueLogEvent(database, issueId, {
        provider: "codex",
        type: "error",
        error: "turn failed",
        status: "failed",
        session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
        raw: { method: "error", payload: "{\"error\":\"turn failed\"}" }
      });

      expect(event.type).toBe("issue.log");
      expect(listIssueEvents(database, issueId).map((item) => item.type)).toEqual(["issue.log"]);
      expect(JSON.parse(event.payload)).toEqual({
        type: "error",
        provider: "codex",
        raw_method: "error",
        raw_payload: "{\"error\":\"turn failed\"}",
        status: "failed",
        error: "turn failed"
      });
    } finally {
      database.close();
    }
  });

  test("stores oversized Codex payloads once as compressed artifacts and hydrates legacy reads", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const rawPayload = JSON.stringify({
        status_code: 429,
        retry_after: 120,
        message: "rate limited",
        diagnostic: "x".repeat(220_000)
      });
      const providerEvent = {
        provider: "codex" as const,
        type: "error",
        error: "HTTP 429: rate limited",
        status: "failed",
        session: { provider: "codex" as const, sessionId: "thread-oversize", turnId: "turn-oversize" },
        raw: { method: "error", payload: rawPayload }
      };

      const live = recordIssueLogEvent(database, issueId, providerEvent);
      recordIssueLogEvent(database, issueId, providerEvent);
      const stored = storedPayload(database, live.id);
      const storedBody = JSON.parse(stored) as Record<string, any>;
      const artifact = storedBody.issue_log_artifact as Record<string, unknown>;
      const hydrated = JSON.parse(listIssueEvents(database, issueId)[0]?.payload ?? "{}") as Record<string, unknown>;

      expect(Buffer.byteLength(stored)).toBeLessThanOrEqual(ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES);
      expect(live.payload).toBe(stored);
      expect(artifact.schema_version).toBe("issue-log-payload-artifact.v1");
      expect(artifact.encoding).toBe("gzip+json");
      expect(typeof artifact.bytes).toBe("number");
      expect(typeof artifact.stored_bytes).toBe("number");
      expect(Number(artifact.stored_bytes)).toBeLessThan(Number(artifact.bytes));
      expect(hydrated).toMatchObject({
        type: "error",
        provider: "codex",
        raw_method: "error",
        raw_payload: rawPayload,
        status: "failed",
        error: "HTTP 429: rate limited"
      });
      expect(parseIssueEventProviderError(hydrated, { now: new Date("2026-01-01T00:00:00Z") })).toMatchObject({
        category: "rate_limit",
        status_code: 429,
        retry_after_seconds: 120
      });
      expect(await artifactFiles(dirname(database.path))).toHaveLength(1);

      await rm(join(dirname(database.path), String(artifact.ref)), { force: true });
      expect(() => listIssueEvents(database, issueId)).toThrow("ENOENT");
      expect(() => listIssueEvents(database, issueId)).toThrow("ENOENT");
      const attention = listAttentionInboxItems(database, { source: "runner.issue_log_artifact_integrity" });
      expect(attention).toHaveLength(2);
      expect(attention).toContainEqual(expect.objectContaining({
        evidence_refs: [`issue_event:${live.id}:issue_log_artifact`],
        primary_intent: "artifact_integrity_failure",
        status: "new",
        urgency: "high"
      }));
    } finally {
      database.close();
    }
  });

  test("applies the same payload cap to Claude output while preserving full replay text", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const text = "Claude decisive output\n".repeat(8_000);
      const event = recordIssueLogEvent(database, issueId, {
        provider: "claude",
        type: "text",
        text,
        session: { provider: "claude", sessionId: "sess-large", turnId: "turn-large" },
        raw: { method: "assistant", payload: JSON.stringify({ type: "assistant", text }) }
      });

      expect(Buffer.byteLength(storedPayload(database, event.id))).toBeLessThanOrEqual(ISSUE_LOG_INLINE_PAYLOAD_LIMIT_BYTES);
      expect(JSON.parse(listIssueEvents(database, issueId)[0]?.payload ?? "{}")).toMatchObject({
        provider: "claude",
        raw_method: "assistant",
        text
      });
    } finally {
      database.close();
    }
  });

  test("externalizes high-amplification lifecycle payloads before the hard inline cap", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const output = "bounded-output\n".repeat(1_000);
      const event = recordIssueLogEvent(database, issueId, {
        provider: "codex",
        type: "tool",
        command: "generate-output",
        status: "completed",
        raw: { method: "item/completed", payload: JSON.stringify({ item: { type: "commandExecution", aggregatedOutput: output } }) }
      });
      const stored = storedPayload(database, event.id);

      expect(Buffer.byteLength(JSON.stringify({ output }))).toBeGreaterThan(ISSUE_LOG_ARTIFACT_THRESHOLD_BYTES);
      expect(JSON.parse(stored)).toMatchObject({ issue_log_artifact: { schema_version: "issue-log-payload-artifact.v1" } });
      expect(JSON.parse(listIssueEvents(database, issueId)[0]!.payload)).toMatchObject({
        raw_method: "item/completed",
        raw_payload: expect.stringContaining("bounded-output")
      });
    } finally {
      database.close();
    }
  });

  test("keeps legacy inline rows readable and rejects malformed artifact references fail closed", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const legacy = recordIssueLogEvent(database, issueId, {
        provider: "codex",
        type: "text",
        text: "legacy inline",
        raw: { method: "assistant", payload: "legacy inline" }
      });
      expect(JSON.parse(listIssueEvents(database, issueId)[0]!.payload)).toMatchObject({ text: "legacy inline" });

      database.sqlite.run("update issue_events set payload=? where id=?", [JSON.stringify({
        type: "text",
        issue_log_artifact: { schema_version: "issue-log-payload-artifact.v1", encoding: "gzip+json", ref: "../escape", sha256: "bad", bytes: 1, stored_bytes: 1 }
      }), legacy.id]);
      expect(() => listIssueEvents(database, issueId)).toThrow("does not reference an artifact");
      expect(listAttentionInboxItems(database, { source: "runner.issue_log_artifact_integrity" })).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  test("rejects a checksum-corrupt artifact and creates Attention", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, "demo");
      const event = recordIssueLogEvent(database, issueId, {
        provider: "codex",
        type: "tool",
        raw: { method: "item/completed", payload: JSON.stringify({ item: { type: "fileChange", diff: "x".repeat(40_000) } }) }
      });
      const stored = JSON.parse(storedPayload(database, event.id)) as Record<string, any>;
      const path = join(dirname(database.path), String(stored.issue_log_artifact.ref));
      const bytes = await readFile(path);
      bytes[Math.floor(bytes.length / 2)] ^= 0xff;
      await writeFile(path, bytes);

      expect(() => listIssueEvents(database, issueId)).toThrow();
      expect(listAttentionInboxItems(database, { source: "runner.issue_log_artifact_integrity" })).toMatchObject([{
        evidence_refs: [`issue_event:${event.id}:issue_log_artifact`]
      }]);
    } finally {
      database.close();
    }
  });
});

function storedPayload(db: RunnerDatabase, id: number): string {
  const row = db.sqlite.query<{ payload: string }, [number]>("select payload from issue_events where id=?").get(id);
  if (!row) throw new Error("missing stored issue event");
  return row.payload;
}

async function artifactFiles(stateDir: string): Promise<string[]> {
  const root = join(stateDir, "artifacts", "issue-logs");
  const shards = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    for (const file of await readdir(join(root, shard.name))) files.push(join(shard.name, file));
  }
  return files;
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectId: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectId, "Events repo", "in_progress", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
