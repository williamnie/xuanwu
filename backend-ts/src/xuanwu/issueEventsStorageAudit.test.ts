import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  auditIssueEventsStorage,
  classifyRetentionValue,
  compareIssueEventsStorage
} from "./issueEventsStorageAudit.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = resolve(REPO_ROOT, "docs/architecture/xuanwu/0006-issue-events-storage-audit.md");

describe("issue_events storage audit", () => {
  test("reports distributions and duplicate fingerprints without exposing payloads or mutating the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "issue-events-audit-"));
    const path = join(directory, "snapshot.db");
    const duplicatePayload = JSON.stringify({
      type: "text",
      provider: "codex",
      raw_method: "item/agentMessage/delta",
      raw_payload: JSON.stringify({ delta: "sensitive-canary" }),
      text: "sensitive-canary"
    });
    try {
      createFixture(path, [
        [1, "issue.log", duplicatePayload, "2026-01-01T00:00:00Z"],
        [2, "issue.log", duplicatePayload, "2026-01-01T01:00:00Z"],
        [1, "issue.log", JSON.stringify({
          type: "tool", provider: "codex", raw_method: "item/completed", command: "echo ok"
        }), "2026-01-02T00:00:00Z"],
        [3, "issue.log", "not-json-sensitive-canary", "2026-01-02T01:00:00Z"],
        [1, "issue.status_changed", JSON.stringify({ from: "todo", to: "done" }), "2026-01-03T00:00:00Z"]
      ]);
      const beforeMtime = statSync(path).mtimeMs;

      const audit = auditIssueEventsStorage(path, { duplicateLimit: 5, issueLimit: 5 });

      expect(audit.source_of_truth).toBe("issue_events");
      expect(audit.totals.event_count).toBe(5);
      expect(audit.totals.issue_log_count).toBe(4);
      expect(audit.distributions.projects.map((row) => row.key)).toEqual(["alpha", "beta"]);
      expect(audit.distributions.providers.map((row) => row.key).sort()).toEqual(["codex", "invalid-json"]);
      expect(audit.distributions.daily.map((row) => row.key)).toEqual([
        "2026-01-01", "2026-01-02", "2026-01-03"
      ]);
      expect(audit.duplicates.duplicate_groups).toBe(1);
      expect(audit.duplicates.duplicate_rows).toBe(1);
      expect(audit.duplicates.top_groups[0]).toMatchObject({
        count: 2,
        event_type: "issue.log",
        payload_bytes_each: Buffer.byteLength(duplicatePayload),
        provider: "codex",
        raw_method: "item/agentMessage/delta"
      });
      expect(audit.duplicates.top_groups[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(audit)).not.toContain("sensitive-canary");
      expect(statSync(path).mtimeMs).toBe(beforeMtime);
      expect(readCount(path)).toBe(5);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("computes a comparable per-day growth rate from event timestamps", () => {
    const directory = mkdtempSync(join(tmpdir(), "issue-events-growth-"));
    const baselinePath = join(directory, "baseline.db");
    const currentPath = join(directory, "current.db");
    try {
      const basePayload = JSON.stringify({ provider: "codex", raw_method: "turn/started", type: "text" });
      const extraPayload = JSON.stringify({ provider: "codex", raw_method: "turn/completed", type: "done" });
      createFixture(baselinePath, [[1, "issue.log", basePayload, "2026-01-01T00:00:00Z"]]);
      createFixture(currentPath, [
        [1, "issue.log", basePayload, "2026-01-01T00:00:00Z"],
        [1, "issue.log", extraPayload, "2026-01-03T00:00:00Z"]
      ]);

      const growth = compareIssueEventsStorage(
        auditIssueEventsStorage(baselinePath),
        auditIssueEventsStorage(currentPath)
      );

      expect(growth.interval_days).toBe(2);
      expect(growth.event_count_delta).toBe(1);
      expect(growth.event_count_per_day).toBe(0.5);
      expect(growth.payload_bytes_delta).toBe(Buffer.byteLength(extraPayload));
      expect(growth.payload_bytes_per_day).toBe(Buffer.byteLength(extraPayload) / 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("keeps conservative retention categories and canonical migration gates documented", () => {
    expect(classifyRetentionValue("issue.status_changed", "")).toBe("R3_AUDIT");
    expect(classifyRetentionValue("issue.log", "turn/completed")).toBe("R3_AUDIT");
    expect(classifyRetentionValue("issue.log", "item/completed")).toBe("R2_DURABLE");
    expect(classifyRetentionValue("issue.log", "turn/diff/updated")).toBe("R1_OPERATIONAL");
    expect(classifyRetentionValue("issue.log", "unknown")).toBe("REVIEW_REQUIRED");

    const adr = readFileSync(ADR_PATH, "utf8");
    for (const marker of [
      "issue_events` 仍是唯一 source of truth",
      "不引入双写或双读",
      "最终删除门禁",
      "只读审计命令",
      "风险报告"
    ]) expect(adr).toContain(marker);
  });
});

type EventFixture = [issueID: number, type: string, payload: string, createdAt: string];

function createFixture(path: string, events: EventFixture[]): void {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.run("create table projects (id text primary key)");
    sqlite.run("create table issues (id integer primary key, project_id text not null)");
    sqlite.run(`create table issue_events (
      id integer primary key autoincrement, issue_id integer not null, type text not null,
      payload text not null default '', created_at text not null
    )`);
    sqlite.run("create index idx_issue_events_issue_type on issue_events(issue_id, type)");
    sqlite.run("insert into projects (id) values ('alpha'), ('beta')");
    sqlite.run("insert into issues (id, project_id) values (1, 'alpha'), (2, 'alpha'), (3, 'beta')");
    for (const event of events) {
      sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)", event);
    }
  } finally {
    sqlite.close();
  }
}

function readCount(path: string): number {
  const sqlite = new Database(path, { readonly: true, strict: true });
  try {
    return sqlite.query<{ count: number }, []>("select count(*) as count from issue_events").get()?.count ?? 0;
  } finally {
    sqlite.close();
  }
}
