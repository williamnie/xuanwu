import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI heartbeat timeline API", () => {
  test("loads timeline rows and filters issue-linked heartbeat/audit events", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueID = insertIssue(database, "demo");
      insertHeartbeatEvent(database, {
        eventType: "collect_signals", heartbeatID: "hb-demo", projectID: "demo",
        payload: { issue_secret: "payload-secret", cwd: "/Users/secret/project" }
      });
      insertHeartbeatEvent(database, {
        eventType: "audit", heartbeatID: "hb-other", projectID: "demo", seconds: 1
      });
      insertActionEvent(database, {
        eventType: "gate_decision", heartbeatID: "hb-demo", issueID, projectID: "demo",
        reason: "Authorization: Bearer bearer-secret at /tmp/secret.log"
      });

      const response = await createDefaultRouter({ database }).handle(
        new Request(`${BASE_URL}/api/pi/heartbeat-timeline?project_id=demo&issue_id=${issueID}`)
      );
      const body = await response.json() as Array<Record<string, unknown>>;
      const text = JSON.stringify(body);

      expect(response.status).toBe(200);
      expect(body.map((item) => item.source)).toEqual(["action", "heartbeat"]);
      expect(body.map((item) => item.stage)).toEqual(["decision", "signal"]);
      expect(body.map((item) => item.heartbeat_id)).toEqual(["hb-demo", "hb-demo"]);
      expect(text).toContain("[redacted]");
      expect(text).toContain("[redacted-path]");
      expect(text).not.toContain("payload-secret");
      expect(text).not.toContain("bearer-secret");
      expect(text).not.toContain("/Users/secret");
      expect(text).not.toContain("/tmp/secret");
    } finally {
      database.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-heartbeat-timeline-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 0, 1, "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, projectID: string): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
    [projectID, "Timeline issue", "triage", "2026-06-04T09:00:00Z", "2026-06-04T09:00:00Z"]
  );
  return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0;
}

function insertHeartbeatEvent(db: RunnerDatabase, input: {
  eventType: string; heartbeatID: string; payload?: unknown; projectID: string; seconds?: number;
}): void {
  db.sqlite.run(
    `insert into pi_heartbeat_events
      (heartbeat_id, project_id, event_type, payload_json, created_at)
     values (?, ?, ?, ?, ?)`,
    [
      input.heartbeatID, input.projectID, input.eventType, JSON.stringify(input.payload ?? {}),
      `2026-06-04T09:00:0${input.seconds ?? 0}Z`
    ]
  );
}

function insertActionEvent(db: RunnerDatabase, input: {
  eventType: string; heartbeatID: string; issueID: number; projectID: string; reason?: string;
}): void {
  db.sqlite.run(
    `insert into pi_action_events
      (action_id, project_id, issue_id, event_type, reason, heartbeat_id, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      "action-demo", input.projectID, input.issueID, input.eventType, input.reason ?? "",
      input.heartbeatID, "2026-06-04T09:00:02Z"
    ]
  );
}
