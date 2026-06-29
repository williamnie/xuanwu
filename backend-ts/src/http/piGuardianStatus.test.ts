import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createPiIssueCompletionWatch, createPiNotificationIntent, upsertPiGuardianWatchdogStatus } from "../db/repositories/pi.ts";
import { createDefaultRouter, registerSystemStatusRoute } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI guardian system status", () => {
  test("returns watchdog last_seen stale_after and is_stale", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      const healthySeen = new Date(Date.now() - 30_000);
      upsertPiGuardianWatchdogStatus(database, {
        checked_components_json: [{ component: "outbox", status: "ok" }],
        last_seen_at: iso(healthySeen),
        last_success_at: iso(healthySeen)
      });
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: "", config, database });

      const healthy = await statusBody(router);
      const staleSeen = new Date(Date.now() - 180_000);
      upsertPiGuardianWatchdogStatus(database, { last_seen_at: iso(staleSeen) });
      const stale = await statusBody(router);

      expect(healthy.pi_guardian.watchdog).toEqual({
        is_stale: false,
        last_seen: iso(healthySeen),
        stale_after: iso(new Date(healthySeen.getTime() + 120_000))
      });
      expect(stale.pi_guardian.watchdog).toEqual({
        is_stale: true,
        last_seen: iso(staleSeen),
        stale_after: iso(new Date(staleSeen.getTime() + 120_000))
      });
    } finally {
      database.close();
    }
  });

  test("exposes completion watch operational counters", async () => {
    const { config, database } = await openFixtureRuntime();
    try {
      insertProject(database, config.stateDir);
      const issue = createIssue(database, { project_id: "demo", status: "todo", title: "Active watch" });
      createPiIssueCompletionWatch(database, {
        issue_ids: [issue.id],
        project_id: "demo",
        source_event_id: "watch-active",
        target_channel: "feishu",
        target_chat_id: "oc_watch"
      });
      createPiNotificationIntent(database, watchIntent("watch-pending", ""));
      createPiNotificationIntent(database, watchIntent("watch-failed", "missing_feishu_target"));
      const router = createDefaultRouter();
      registerSystemStatusRoute(router, { authToken: "", config, database });

      const body = await statusBody(router);

      expect(body.pi_guardian.completion_watch).toEqual({
        active_watches: 1,
        failed_notification: 1,
        satisfied_pending_notification: 1
      });
    } finally {
      database.close();
    }
  });
});

async function openFixtureRuntime(): Promise<{
  config: ReturnType<typeof buildConfig>;
  database: RunnerDatabase;
}> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-guardian-status-"));
  tempRoots.push(root);
  const stateDir = join(root, "state");
  const config = buildConfig({ stateDir });
  const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
  return { config, database };
}

async function statusBody(router: ReturnType<typeof createDefaultRouter>): Promise<SystemStatusBody> {
  const response = await router.handle(new Request(`${BASE_URL}/api/system/status`));
  expect(response.status).toBe(200);
  return await response.json() as SystemStatusBody;
}

function insertProject(db: RunnerDatabase, root: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, provider_config_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), "codex", "{}", 1, "2026-06-29T00:00:00Z", "2026-06-29T00:00:00Z"]
  );
}

function watchIntent(watchID: string, error: string): Record<string, unknown> {
  return {
    error,
    id: `intent-${watchID}`,
    idempotency_key: `issue_completion_watch_satisfied:${watchID}`,
    issue_id: 1,
    kind: "issue_completion_watch_satisfied",
    project_id: "demo",
    state: "ready",
    target_channel: "feishu",
    target_chat_id: "oc_watch"
  };
}

type SystemStatusBody = {
  pi_guardian: {
    completion_watch: Record<string, number>;
    watchdog: { is_stale: boolean; last_seen: string; stale_after: string };
  };
};

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
