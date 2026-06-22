import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listNotifications } from "../db/repositories/notifications.ts";
import { EventBus } from "../events/bus.ts";
import type { ProjectFinding } from "../pi/projectFindings.ts";
import { publishNeedsUserFindingNotifications, publishPiNeedsUserNotification } from "./piNotifier.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-notifier-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI needs-user notification engine", () => {
  test("publishes redacted needs-user payloads through the event bus", async () => {
    const bus = new EventBus();
    const events = bus.subscribe();
    const finding = findingRecord({
      message: "approval denied CODEX_API_KEY=fixture-secret at /Users/secret/log.txt",
      title: "Needs user at /Users/secret/project"
    });

    const payloads = publishNeedsUserFindingNotifications({
      bus,
      findings: [finding],
      now: new Date("2026-01-01T00:00:00Z"),
      notifyOnNeedsUser: true,
      project: { id: "demo", name: "Demo TOKEN=project-secret" }
    });

    const event = await events.next();
    events.close();
    const payloadText = JSON.stringify(payloads);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: "pi.needs_user",
      issue_id: 7,
      project_id: "demo",
      reason: "needs_user"
    });
    expect(event).toMatchObject({ type: "pi.needs_user", issueId: 7, projectId: "demo" });
    expect(event?.payload).toBe(JSON.stringify(payloads[0]));
    expect(payloadText).toContain("[redacted]");
    expect(payloadText).toContain("[redacted-path]");
    expect(payloadText).not.toContain("fixture-secret");
    expect(payloadText).not.toContain("project-secret");
    expect(payloadText).not.toContain("/Users/secret");
  });

  test("skips needs-user notifications when project settings disable them", () => {
    const bus = new EventBus();

    const payloads = publishNeedsUserFindingNotifications({
      bus,
      findings: [findingRecord({ message: "waiting for user input" })],
      notifyOnNeedsUser: false,
      project: { id: "demo", name: "Demo" }
    });

    expect(payloads).toEqual([]);
    expect(bus.subscriberCount()).toBe(0);
  });

  test("records needs-user notifications with issue cooldown", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertIssue(database, 7, "demo");
      const input = {
        database,
        findings: [findingRecord({ message: "waiting for user input" })],
        notifyOnNeedsUser: true,
        project: { id: "demo", name: "Demo" }
      };

      const first = publishNeedsUserFindingNotifications({
        ...input,
        now: new Date("2026-01-01T00:00:00Z")
      });
      const second = publishNeedsUserFindingNotifications({
        ...input,
        now: new Date("2026-01-01T00:10:00Z")
      });
      const afterCooldown = publishNeedsUserFindingNotifications({
        ...input,
        now: new Date("2026-01-01T00:31:00Z")
      });

      expect(first).toHaveLength(1);
      expect(second).toEqual([]);
      expect(afterCooldown).toHaveLength(1);
      expect(listNotificationRows(database)).toEqual([
        { event: "pi.needs_user", issue_id: 7, project_id: "demo", read_at: "" },
        { event: "pi.needs_user", issue_id: 7, project_id: "demo", read_at: "" }
      ]);
    } finally {
      database.close();
    }
  });

  test("dedupes action needs-user notifications by action id", async () => {
    const database = await openFixtureDatabase();
    const bus = new EventBus();
    const events: unknown[] = [];
    const stop = bus.observe((event) => events.push(event));
    try {
      insertProject(database, "demo");
      insertIssue(database, 7, "demo");
      const input = {
        actionID: "needs-user-action",
        bus,
        database,
        diagnosis: "provider_auth_failed",
        issue: { id: 7, project_id: "demo", status: "failed", title: "Needs user" },
        message: "Provider failed TOKEN=secret at /Users/secret/log.ts\n    at leak (/tmp/stack.js:1)",
        nextStep: "Refresh provider credentials and retry.",
        project: { id: "demo", name: "Demo" },
        provider: "codex"
      };

      const first = publishPiNeedsUserNotification({ ...input, now: new Date("2026-01-01T00:00:00Z") });
      const duplicate = publishPiNeedsUserNotification({ ...input, now: new Date("2026-01-01T00:10:00Z") });
      const nextAction = publishPiNeedsUserNotification({
        ...input,
        actionID: "needs-user-action-2",
        now: new Date("2026-01-01T00:11:00Z")
      });
      const text = JSON.stringify({ events, first, rows: listNotifications(database, { unreadOnly: true }) });

      expect(first).toMatchObject({
        action_id: "needs-user-action",
        event: "pi.needs_user",
        issue_id: 7,
        provider: "codex",
        reason: "provider_auth_failed"
      });
      expect(duplicate).toBeNull();
      expect(nextAction).toMatchObject({ action_id: "needs-user-action-2" });
      expect(events).toHaveLength(2);
      expect(listNotifications(database, { unreadOnly: true })).toHaveLength(2);
      expect(text).toContain("Refresh provider credentials");
      expect(text).not.toContain("secret");
      expect(text).not.toContain("/Users/secret");
      expect(text).not.toContain("at leak");
    } finally {
      stop();
      database.close();
    }
  });
});

function findingRecord(input: { message: string; title?: string }): ProjectFinding {
  return {
    category: "needs_user",
    issue_id: 7,
    message: input.message,
    notification: { type: "pi.needs_user", message: input.message },
    project_id: "demo",
    reason: "needs_user",
    severity: "blocked",
    status: "failed",
    title: input.title ?? "Needs user",
    updated_at: "2026-01-01T00:00:00Z"
  };
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, id: number, projectID: string): void {
  db.sqlite.run(
    `insert into issues (id, project_id, title, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, projectID, "Needs user", "failed", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function listNotificationRows(db: RunnerDatabase): Array<Record<string, unknown>> {
  return db.sqlite.query<Record<string, unknown>, []>(
    "select event, issue_id, project_id, read_at from notifications order by id asc"
  ).all();
}
