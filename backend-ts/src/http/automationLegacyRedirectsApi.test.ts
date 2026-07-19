import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const ROOTS: string[] = [];
const BASE = "http://127.0.0.1:3008";

const LEGACY_ROUTES = [
  ["GET", "/api/cron-tasks"], ["POST", "/api/cron-tasks"],
  ["PATCH", "/api/cron-tasks/1"], ["DELETE", "/api/cron-tasks/1"],
  ["GET", "/api/pi/automations"], ["POST", "/api/pi/automations"],
  ["GET", "/api/pi/automations/runnable"], ["GET", "/api/pi/automations/1"],
  ["PATCH", "/api/pi/automations/1"], ["GET", "/api/pi/delegations"],
  ["POST", "/api/pi/delegations"], ["GET", "/api/pi/delegations/legacy"],
  ["PATCH", "/api/pi/delegations/legacy"], ["POST", "/api/pi/delegations/legacy/pause"],
  ["POST", "/api/pi/delegations/legacy/resume"], ["POST", "/api/pi/delegations/legacy/expire"],
  ["GET", "/api/pi/issue-completion-watches"], ["GET", "/api/pi/issue-completion-watches/legacy"],
  ["POST", "/api/pi/issue-completion-watches/legacy/cancel"], ["POST", "/api/pi/source-policies"],
  ["PATCH", "/api/pi/source-policies/automations/1"]
] as const;

afterEach(async () => {
  while (ROOTS.length) await rm(ROOTS.pop()!, { recursive: true, force: true });
});

describe("Automation legacy redirects", () => {
  test("redirects every retired scheduler API without touching legacy carriers and audits usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "automation-redirects-"));
    ROOTS.push(root);
    const db = await openDatabase({ stateDir: join(root, "state") });
    try {
      const router = createDefaultRouter({ database: db });
      for (const [method, path] of LEGACY_ROUTES) {
        const response = await router.handle(new Request(`${BASE}${path}`, {
          headers: { "content-type": "application/json", "x-codex-client": "cutover-test" },
          method,
          ...(["POST", "PATCH"].includes(method) ? { body: "{}" } : {})
        }));
        expect(response.status).toBe(308);
        expect(response.headers.get("location")).toBe("/api/automations");
        expect(response.headers.get("x-codex-automation-authority")).toBe("automation_definitions");
      }
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from cron_tasks").get()?.count).toBe(0);
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_automations").get()?.count).toBe(0);
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_delegations").get()?.count).toBe(0);
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from pi_issue_completion_watches").get()?.count).toBe(0);
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from pi_action_events where event_type='compatibility.automation_legacy_used.v1'"
      ).get()?.count).toBe(LEGACY_ROUTES.length);
    } finally {
      db.close();
    }
  });
});
