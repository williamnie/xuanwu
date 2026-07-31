import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  getPiGuardianAlert,
  resolvePiGuardianAlert,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI guardian alerts API", () => {
  test("lists open alerts with redacted response payloads", async () => {
    const db = await fixtureDatabase();
    try {
      upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled",
        evidence_json: { api_key: "fixture-secret", log: "failed at /Users/xiaobei/private/outbox.log" },
        id: "alert-open",
        message: "Outbox stalled CODEX_API_KEY=fixture-secret at /Users/xiaobei/private/outbox.log",
        project_id: "demo",
        watchdog_seen_at: "2026-06-19T01:00:00Z"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "pi_runtime_down",
        id: "alert-acked",
        message: "Already acknowledged",
        project_id: "demo",
        status: "acked"
      });
      const router = createDefaultRouter({ database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/guardian/alerts?project_id=demo`));
      const text = await response.text();
      const body = JSON.parse(text) as Array<Record<string, unknown>>;

      expect(response.status).toBe(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ id: "alert-open", status: "open", project_id: "demo" });
      expect(body[0]).toMatchObject({
        presentation: {
          component: "通知发送队列",
          location: "项目 demo",
          title: "通知发送暂时延迟"
        }
      });
      expect(text).not.toContain("evidence_json");
      expect(text).not.toContain("fixture-secret");
      expect(text).not.toContain("/Users/xiaobei/private");
      expect(text).toContain("[redacted]");
      expect(text).toContain("[redacted-path]");
    } finally {
      db.close();
    }
  });

  test("returns one exact alert with its user-facing diagnosis", async () => {
    const db = await fixtureDatabase();
    try {
      upsertPiGuardianAlert(db, {
        alert_type: "scheduler_stalled",
        id: "alert-detail",
        message: "scheduler stalled",
        project_id: "demo"
      });
      const router = createDefaultRouter({ database: db });

      const response = await router.handle(new Request(`${BASE_URL}/api/pi/guardian/alerts/alert-detail`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "alert-detail",
        presentation: {
          component: "Supervisor 调度器",
          handling: "pi_handling",
          requires_user: false,
          user_action: expect.stringContaining("当前无需操作")
        }
      });
    } finally {
      db.close();
    }
  });

  test("ack is idempotent and terminal alerts are no-op", async () => {
    const db = await fixtureDatabase();
    try {
      upsertPiGuardianAlert(db, {
        alert_type: "digest_flush_stalled",
        id: "alert-ack",
        message: "Digest flush stalled",
        project_id: "demo"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "pi_runtime_down",
        id: "alert-terminal",
        message: "PI recovered",
        project_id: "demo"
      });
      resolvePiGuardianAlert(db, "alert-terminal", { message: "PI recovered" });
      const router = createDefaultRouter({ database: db });

      const first = await post(router, "/api/pi/guardian/alerts/alert-ack/ack");
      const second = await post(router, "/api/pi/guardian/alerts/alert-ack/ack");
      const terminal = await post(router, "/api/pi/guardian/alerts/alert-terminal/ack");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(terminal.status).toBe(200);
      expect(await first.json()).toMatchObject({ id: "alert-ack", status: "acked" });
      expect(await second.json()).toMatchObject({ id: "alert-ack", status: "acked" });
      expect(await terminal.json()).toMatchObject({ id: "alert-terminal", status: "resolved" });
      expect(getPiGuardianAlert(db, "alert-terminal")).toMatchObject({ status: "resolved" });
    } finally {
      db.close();
    }
  });

  test("returns unauthorized and missing ack errors without leaking details", async () => {
    const db = await fixtureDatabase();
    try {
      const router = createDefaultRouter({ database: db });
      const handle = createRequestHandler(router, "guardian-secret");

      const unauthorized = await handle(new Request(`${BASE_URL}/api/pi/guardian/alerts`));
      const missing = await handle(new Request(`${BASE_URL}/api/pi/guardian/alerts/missing-alert/ack`, {
        headers: { authorization: "Bearer guardian-secret" },
        method: "POST"
      }));

      expect(unauthorized.status).toBe(401);
      expect(await unauthorized.json()).toEqual({ message: "unauthorized" });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-alerts-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function post(router: ReturnType<typeof createDefaultRouter>, path: string): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, { method: "POST" }));
}
