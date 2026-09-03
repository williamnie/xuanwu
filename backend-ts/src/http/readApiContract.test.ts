import { describe, expect, test } from "bun:test";
import type { RunnerDatabase } from "../db/database.ts";
import { AUTOMATION_API_AUTHORITY, registerAutomationRoutes } from "./automationApi.ts";
import {
  COMMAND_CENTER_COMPATIBILITY_POLICY,
  COMMAND_CENTER_SUMMARY_CONTRACT,
  registerCommandCenterRoutes
} from "./commandCenterApi.ts";
import { EVIDENCE_HTTP_COMPATIBILITY_POLICY, registerEvidenceRoutes } from "./evidenceApi.ts";
import { FRONTEND_COMPATIBILITY_POLICY, registerFrontendCompatRoutes } from "./frontendCompatApi.ts";
import { registerHandoffRoutes } from "./handoffApi.ts";
import { READ_API_ROUTE_REGISTRY } from "./readApi.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { registerCoreReadRoutes } from "./readApiRoutes.ts";
import { registerRunRoutes, RUN_READ_AUTHORITY, RUN_WRITE_AUTHORITY } from "./runApi.ts";
import type { Router } from "./router.ts";
import { registerWorkRoutes } from "./workApi.ts";

describe("read API route contracts", () => {
  test("locks the route registry responsibility boundary", () => {
    expect(READ_API_ROUTE_REGISTRY.map(({ id, responsibility }) => ({ id, responsibility })))
      .toMatchInlineSnapshot(`
        [
          {
            "id": "automations",
            "responsibility": "domain",
          },
          {
            "id": "automation-legacy-redirects",
            "responsibility": "legacy-compatibility",
          },
          {
            "id": "command-center",
            "responsibility": "projection",
          },
          {
            "id": "evidence",
            "responsibility": "domain",
          },
          {
            "id": "event-summaries",
            "responsibility": "projection",
          },
          {
            "id": "core-read",
            "responsibility": "domain",
          },
          {
            "id": "pi-supervisor",
            "responsibility": "domain",
          },
          {
            "id": "pi",
            "responsibility": "domain",
          },
          {
            "id": "runs",
            "responsibility": "domain",
          },
          {
            "id": "sessions",
            "responsibility": "domain",
          },
          {
            "id": "work",
            "responsibility": "domain",
          },
          {
            "id": "frontend-compat",
            "responsibility": "legacy-compatibility",
          },
          {
            "id": "handoffs",
            "responsibility": "domain",
          },
          {
            "id": "legacy-compatibility",
            "responsibility": "projection",
          },
          {
            "id": "usage",
            "responsibility": "projection",
          },
        ]
      `);
  });

  test("locks Command Center read and audited Attention command contracts", () => {
    expect(captureRoutes(registerCommandCenterRoutes)).toEqual([
      "GET /api/command-center/attention/:id",
      "GET /api/command-center/summary",
      "POST /api/command-center/attention/:id/actions/:action"
    ]);
    expect(COMMAND_CENTER_SUMMARY_CONTRACT).toBe("xw.command-center.summary.v1");
    expect(COMMAND_CENTER_COMPATIBILITY_POLICY.dual_read).toContain("none");
    expect(COMMAND_CENTER_COMPATIBILITY_POLICY.dual_write).toContain("none");
    expect(COMMAND_CENTER_COMPATIBILITY_POLICY.handoff_read_authority).toBe("issue_events:handoff.*.v1");
    expect(COMMAND_CENTER_COMPATIBILITY_POLICY.work_read_authority).toBe("issues-via-Work-adapter");
  });

  test("locks native Automation methods and single-authority contract", () => {
    expect(captureRoutes(registerAutomationRoutes)).toEqual([
      "GET /api/automations",
      "GET /api/automations/:id",
      "PATCH /api/automations/:id",
      "PATCH /api/automations/:id/trigger",
      "POST /api/automations",
      "POST /api/automations/:id/run-now",
      "POST /api/automations/:id/status"
    ]);
    expect(AUTOMATION_API_AUTHORITY).toMatchObject({
      definition: "automation_definitions",
      dual_read: "none",
      dual_write: "none",
      runs: "automation_runs",
      final_delete_gate: expect.stringContaining("P11/G7")
    });
  });

  test("locks Evidence method, path, and authority contracts", () => {
    expect(captureRoutes(registerEvidenceRoutes)).toEqual([
      "GET /api/evidence",
      "GET /api/evidence/:id",
      "GET /api/evidence/:id/artifacts/:index",
      "POST /api/issues/:id/evidence/readiness"
    ]);
    expect(EVIDENCE_HTTP_COMPATIBILITY_POLICY).toMatchObject({
      dual_write: expect.stringContaining("none"),
      fact_authority: expect.stringContaining("originating"),
      read_authority: "issue_events:evidence.recorded.v1"
    });
  });

  test("locks Handoff method, path, and authority contracts", () => {
    expect(captureRoutes(registerHandoffRoutes)).toEqual([
      "GET /api/handoffs",
      "GET /api/handoffs/:id"
    ]);
  });

  test("locks Run method, path, and authority contracts", () => {
    expect(captureRoutes(registerRunRoutes)).toEqual([
      "GET /api/runs",
      "GET /api/runs/:id",
      "GET /api/runs/:id/transcript",
      "POST /api/runs/:id/actions/:action"
    ]);
    expect(RUN_READ_AUTHORITY).toBe("issue_runs");
    expect(RUN_WRITE_AUTHORITY).toBe("domain-run-command-service-over-issue_runs");
  });

  test("locks core domain method and path contracts", () => {
    expect(captureRoutes(registerCoreReadRoutes)).toMatchInlineSnapshot(`
      [
        "DELETE /api/issues/:id",
        "GET /api/agent-profiles",
        "GET /api/issues",
        "GET /api/issues/:id",
        "GET /api/issues/:id/events",
        "GET /api/issues/:id/runs",
        "GET /api/projects",
        "GET /api/projects/:id",
        "PATCH /api/issues/:id",
        "PATCH /api/projects/:id",
        "POST /api/issues",
        "POST /api/issues/:id/cancel",
        "POST /api/issues/:id/comments",
        "POST /api/issues/:id/enqueue",
        "POST /api/issues/:id/human-review-requests",
        "POST /api/issues/:id/human-review-response",
        "POST /api/issues/:id/retry",
        "POST /api/projects",
      ]
    `);
  });

  test("locks Work method and path contracts", () => {
    expect(captureRoutes(registerWorkRoutes)).toMatchInlineSnapshot(`
      [
        "GET /api/works",
        "GET /api/works/:id",
        "GET /api/works/:id/timeline",
        "GET /api/works/board",
        "GET /api/works/summary",
        "PATCH /api/works/:id",
        "POST /api/works",
        "POST /api/works/:id/actions/:action",
        "PUT /api/works/:id/readiness-requirements",
      ]
    `);
  });

  test("locks legacy frontend compatibility routes and authority policy", () => {
    expect(captureRoutes(registerFrontendCompatRoutes)).toMatchInlineSnapshot(`
      [
        "DELETE /api/agent-profiles/:id",
        "DELETE /api/projects/:id",
        "GET /api/capabilities",
        "GET /api/codex/models",
        "GET /api/notifications",
        "GET /api/projects/:id/loop/status",
        "GET /api/projects/:id/references/search",
        "GET /api/session-images",
        "GET /api/uploads/:id/content",
        "PATCH /api/agent-profiles/:id",
        "PATCH /api/projects",
        "POST /api/agent-profiles",
        "POST /api/codex/approvals/:id/resolve",
        "POST /api/commands",
        "POST /api/notifications/:id/read",
        "POST /api/projects/:id/hold/resume",
        "POST /api/projects/:id/loop/start",
        "POST /api/projects/:id/loop/stop",
        "POST /api/projects/sync/codex",
        "POST /api/system/restart",
        "POST /api/uploads/images",
      ]
    `);
    expect(FRONTEND_COMPATIBILITY_POLICY).toEqual({
      authority: "existing-domain-repositories",
      dualReadWrite: "none",
      removalGate: "G7-and-item-specific-P11-zero-consumer",
      rollback: "restore-prior-route-registry-without-data-migration"
    });
  });
});

type RouteRegistrar = (router: Router, context: ReadApiContext) => void;

function captureRoutes(register: RouteRegistrar): string[] {
  const routes: string[] = [];
  const add = (method: string): Router["get"] => (path) => routes.push(`${method} ${path}`);
  const router: Router = {
    delete: add("DELETE"),
    get: add("GET"),
    handle: async () => new Response(),
    patch: add("PATCH"),
    post: add("POST"),
    put: add("PUT")
  };
  register(router, { database: {} as RunnerDatabase });
  return routes.sort();
}
