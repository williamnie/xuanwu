import type { RunnerDatabase } from "../db/database.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

export const AUTOMATION_COMPATIBILITY_CONTRACT = "xw.automation-target-primary.v1";
export const AUTOMATION_COMPATIBILITY_SUNSET = "Fri, 01 Jan 2027 00:00:00 GMT";

const COLLECTION = "/api/automations";
export const AUTOMATION_LEGACY_REDIRECT_ROUTES = [
  ["GET", "/api/cron-tasks"],
  ["POST", "/api/cron-tasks"],
  ["PATCH", "/api/cron-tasks/:id"],
  ["DELETE", "/api/cron-tasks/:id"],
  ["GET", "/api/pi/automations"],
  ["POST", "/api/pi/automations"],
  ["GET", "/api/pi/automations/runnable"],
  ["GET", "/api/pi/automations/:id"],
  ["PATCH", "/api/pi/automations/:id"],
  ["GET", "/api/pi/delegations"],
  ["POST", "/api/pi/delegations"],
  ["GET", "/api/pi/delegations/:id"],
  ["PATCH", "/api/pi/delegations/:id"],
  ["POST", "/api/pi/delegations/:id/pause"],
  ["POST", "/api/pi/delegations/:id/resume"],
  ["POST", "/api/pi/delegations/:id/expire"],
  ["GET", "/api/pi/issue-completion-watches"],
  ["GET", "/api/pi/issue-completion-watches/:id"],
  ["POST", "/api/pi/issue-completion-watches/:id/cancel"],
  ["POST", "/api/pi/source-policies"],
  ["PATCH", "/api/pi/source-policies/automations/:id"]
] as const;

type LegacyMethod = typeof AUTOMATION_LEGACY_REDIRECT_ROUTES[number][0];

/**
 * W2 compatibility routes never touch legacy carriers. They provide an
 * auditable permanent redirect to the sole Automation command surface.
 */
export function registerAutomationLegacyRedirectRoutes(
  router: Router,
  context: { database: RunnerDatabase }
): void {
  router.get("/api/compatibility/automations", () => json(compatibilityReport(context.database)));
  for (const [method, path] of AUTOMATION_LEGACY_REDIRECT_ROUTES) {
    const register = router[method.toLowerCase() as Lowercase<LegacyMethod>] as (
      route: string,
      handler: (request: Request) => Response
    ) => void;
    register(path, (request) => redirectResponse(context.database, request));
  }
}

function redirectResponse(db: RunnerDatabase, request: Request): Response {
  const source = new URL(request.url).pathname;
  recordUsage(db, request, source);
  return json({
    contract: AUTOMATION_COMPATIBILITY_CONTRACT,
    deprecated: true,
    location: COLLECTION,
    message: "Legacy Automation API is read-only retired; use /api/automations"
  }, {
    status: 308,
    headers: compatibilityHeaders()
  });
}

function compatibilityHeaders(): Headers {
  const headers = new Headers({
    Deprecation: "true",
    Location: COLLECTION,
    Sunset: AUTOMATION_COMPATIBILITY_SUNSET,
    "X-Codex-Automation-Authority": "automation_definitions"
  });
  headers.set("Link", `<${COLLECTION}>; rel="successor-version"`);
  return headers;
}

function compatibilityReport(db: RunnerDatabase): Record<string, unknown> {
  return {
    contract: AUTOMATION_COMPATIBILITY_CONTRACT,
    redirects: AUTOMATION_LEGACY_REDIRECT_ROUTES.map(([method, path]) => ({ method, path, target: COLLECTION })),
    source_of_truth: "automation_definitions+automation_trigger_configs+automation_runs+automation_watches",
    writes: "target-only",
    legacy_scheduler: "disabled",
    usage_since_cutover: usageRows(db)
  };
}

function recordUsage(db: RunnerDatabase, request: Request, path: string): void {
  if (db.readonly) return;
  try {
    db.sqlite.run(`insert into pi_action_events (
      action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
      reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at
    ) values (?, '', 0, '', 'compatibility.automation_legacy_used.v1', ?, 'redirect',
      'legacy Automation route redirected', ?, '{"status":308}', '', '', '', ?)`, [
      `automation-compat:${crypto.randomUUID()}`,
      request.headers.get("x-codex-client")?.trim() || "http-unknown",
      JSON.stringify({ method: request.method, path, target: COLLECTION }),
      new Date().toISOString()
    ]);
  } catch {
    // Compatibility telemetry must not affect the deterministic redirect.
  }
}

function usageRows(db: RunnerDatabase): Record<string, unknown>[] {
  return db.sqlite.query<Record<string, unknown>, []>(`
    select json_extract(payload_json, '$.method') as method,
      json_extract(payload_json, '$.path') as path, actor as client,
      count(*) as count, min(created_at) as first_seen, max(created_at) as last_seen
    from pi_action_events
    where event_type='compatibility.automation_legacy_used.v1'
    group by method, path, client
    order by last_seen desc, path asc
  `).all();
}
