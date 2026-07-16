import { describe, expect, test } from "bun:test";
import type { RunnerDatabase } from "../db/database.ts";
import { EVIDENCE_HTTP_COMPATIBILITY_POLICY, registerEvidenceRoutes } from "./evidenceApi.ts";
import { FRONTEND_COMPATIBILITY_POLICY, registerFrontendCompatRoutes } from "./frontendCompatApi.ts";
import { READ_API_ROUTE_REGISTRY } from "./readApi.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import { registerCoreReadRoutes } from "./readApiRoutes.ts";
import { registerRunRoutes, RUN_HTTP_COMPATIBILITY_POLICY } from "./runApi.ts";
import type { Router } from "./router.ts";
import { registerWorkRoutes } from "./workApi.ts";

describe("read API route contracts", () => {
  test("locks the route registry responsibility boundary", () => {
    expect(READ_API_ROUTE_REGISTRY.map(({ id, responsibility }) => ({ id, responsibility })))
      .toMatchInlineSnapshot(`
        [
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
            "id": "usage",
            "responsibility": "projection",
          },
        ]
      `);
  });

  test("locks Evidence method, path, and authority contracts", () => {
    expect(captureRoutes(registerEvidenceRoutes)).toEqual([
      "GET /api/evidence",
      "GET /api/evidence/:id",
      "GET /api/evidence/:id/artifacts/:index"
    ]);
    expect(EVIDENCE_HTTP_COMPATIBILITY_POLICY).toMatchObject({
      dual_write: expect.stringContaining("none"),
      fact_authority: expect.stringContaining("originating"),
      read_authority: "issue_events:evidence.recorded.v1"
    });
  });

  test("locks Run method, path, and authority contracts", () => {
    expect(captureRoutes(registerRunRoutes)).toEqual([
      "GET /api/runs",
      "GET /api/runs/:id",
      "POST /api/runs/:id/actions/:action"
    ]);
    expect(RUN_HTTP_COMPATIBILITY_POLICY).toMatchObject({
      attempt_authority: "run_attempts-child-facts",
      dual_write: "none",
      read_authority: "issue_runs",
      session_authority: "agent_sessions-observation-only",
      write_authority: "domain-run-command-service-over-issue_runs"
    });
  });

  test("locks core domain method and path contracts", () => {
    expect(captureRoutes(registerCoreReadRoutes)).toMatchInlineSnapshot(`
      [
        "DELETE /api/issues/:id",
        "GET /api/agent-profiles",
        "GET /api/cron-tasks",
        "GET /api/issue-templates",
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
        "POST /api/issues/:id/retry",
        "POST /api/issues/:id/verification",
        "POST /api/projects",
      ]
    `);
  });

  test("locks Work method and path contracts", () => {
    expect(captureRoutes(registerWorkRoutes)).toMatchInlineSnapshot(`
      [
        "GET /api/work-relations",
        "GET /api/works",
        "GET /api/works/:id",
        "GET /api/works/:id/relations",
        "GET /api/works/:id/timeline",
        "PATCH /api/works/:id",
        "POST /api/works",
        "POST /api/works/:id/actions/:action",
      ]
    `);
  });

  test("locks legacy frontend compatibility routes and authority policy", () => {
    expect(captureRoutes(registerFrontendCompatRoutes)).toMatchInlineSnapshot(`
      [
        "DELETE /api/agent-profiles/:id",
        "DELETE /api/cron-tasks/:id",
        "DELETE /api/issue-templates/:id",
        "DELETE /api/projects/:id",
        "GET /api/capabilities",
        "GET /api/codex/models",
        "GET /api/issue-templates/:id",
        "GET /api/notifications",
        "GET /api/projects/:id/loop/status",
        "GET /api/projects/:id/references/search",
        "GET /api/session-images",
        "GET /api/uploads/:id/content",
        "PATCH /api/agent-profiles/:id",
        "PATCH /api/cron-tasks/:id",
        "PATCH /api/issue-templates/:id",
        "PATCH /api/projects",
        "POST /api/agent-profiles",
        "POST /api/codex/approvals/:id/resolve",
        "POST /api/commands",
        "POST /api/cron-tasks",
        "POST /api/issue-templates",
        "POST /api/issues/:id/verifier-report",
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
