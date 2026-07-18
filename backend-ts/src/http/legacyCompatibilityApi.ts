import type { RunnerDatabase } from "../db/database.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

export const LEGACY_COMPATIBILITY_CONTRACT = "xw.legacy-issues-sessions.compat.v1";
export const LEGACY_COMPATIBILITY_SUNSET = "Fri, 01 Jan 2027 00:00:00 GMT";
export const LEGACY_COMPATIBILITY_REMOVAL_VERSION = "v0.4.0";

const LEGACY_USAGE_EVENT = "compatibility.legacy_used.v1";
const DEPRECATION_LINK = "/api/compatibility/legacy";
const MIGRATION_GUIDE = "docs/migrations/issues-sessions-compat-v1.md";

const LEGACY_FAMILIES = {
  issues: {
    canonical_api: "/api/works",
    canonical_route: "work",
    path: /^\/api\/issues(?:\/|$)/,
  },
  sessions: {
    canonical_api: "/api/runs",
    canonical_route: "runs",
    path: /^\/api\/sessions(?:\/|$)/,
  },
} as const;

type LegacyFamily = keyof typeof LEGACY_FAMILIES;
type UsageRow = {
  client: unknown;
  count: unknown;
  family: unknown;
  first_seen: unknown;
  last_seen: unknown;
  method: unknown;
  path: unknown;
  status: unknown;
  surface: unknown;
};

export function registerLegacyCompatibilityRoutes(router: Router, context: { database: RunnerDatabase }): void {
  router.get("/api/compatibility/legacy", () => json(compatibilityReport(context.database)));
  router.post("/api/compatibility/legacy/usage", async (request) => {
    const body = await objectBody(request);
    const family = legacyFamily(body.family);
    const target = text(body.target, 80);
    recordLegacyCompatibilityUsage(context.database, {
      client: requestClient(request),
      family,
      method: "NAVIGATE",
      path: family,
      status: 200,
      surface: "frontend_route",
      target,
    });
    return json({ recorded: true }, { status: 202 });
  });
}

export function instrumentLegacyCompatibilityResponse(
  request: Request,
  response: Response,
  database?: RunnerDatabase,
): Response {
  const family = apiFamily(new URL(request.url).pathname);
  if (!family || response.status === 401 || response.status === 403) return response;

  if (database) {
    recordLegacyCompatibilityUsage(database, {
      client: requestClient(request),
      family,
      method: request.method,
      path: normalizedApiPath(family, new URL(request.url).pathname),
      status: response.status,
      surface: "http_api",
      target: LEGACY_FAMILIES[family].canonical_api,
    });
  }

  const headers = new Headers(response.headers);
  headers.set("Deprecation", "true");
  headers.set("Sunset", LEGACY_COMPATIBILITY_SUNSET);
  headers.set("X-Codex-Compat-Version", LEGACY_COMPATIBILITY_CONTRACT);
  headers.set("X-Codex-Canonical-Resource", LEGACY_FAMILIES[family].canonical_api);
  headers.append("Link", `<${DEPRECATION_LINK}>; rel=\"deprecation\"; type=\"application/json\"`);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function compatibilityReport(database: RunnerDatabase): Record<string, unknown> {
  return {
    contract: LEGACY_COMPATIBILITY_CONTRACT,
    current_window: "G5-user-route-retirement",
    migration_guide: MIGRATION_GUIDE,
    removal: {
      earliest_version: LEGACY_COMPATIBILITY_REMOVAL_VERSION,
      not_before: LEGACY_COMPATIBILITY_SUNSET,
      required_gates: [
        "one-formal-release-zero-external-consumer",
        "contract-snapshot-retained",
        "previous-release-rollback-smoke",
        "backup-restore-evidence",
        "G7-non-LLM-approval",
      ],
    },
    routes: Object.fromEntries(Object.entries(LEGACY_FAMILIES).map(([family, policy]) => [family, {
      canonical_api: policy.canonical_api,
      canonical_route: policy.canonical_route,
      compatibility: family === "issues" ? "shared-authority-adapter" : "observation-or-provider-conversation-only",
    }])),
    source_of_truth: {
      issues: "issues-and-issue_events-via-shared-Work-domain-adapter",
      runs: "issue_runs-and-run_attempts",
      sessions: "agent_sessions-and-provider-transcript-observation-only",
    },
    usage: compatibilityUsage(database),
  };
}

function compatibilityUsage(database: RunnerDatabase): UsageRow[] {
  const rows = database.sqlite.query<UsageRow, [string]>(`
    select
      coalesce(json_extract(payload_json, '$.surface'), '') as surface,
      coalesce(json_extract(payload_json, '$.family'), '') as family,
      coalesce(json_extract(payload_json, '$.client'), '') as client,
      coalesce(json_extract(payload_json, '$.method'), '') as method,
      coalesce(json_extract(payload_json, '$.path'), '') as path,
      coalesce(json_extract(result_json, '$.status'), 0) as status,
      count(*) as count,
      min(created_at) as first_seen,
      max(created_at) as last_seen
    from pi_action_events
    where event_type=?
    group by surface, family, client, method, path, status
    order by last_seen desc, family asc, path asc
  `).all(LEGACY_USAGE_EVENT);
  return rows.map((row) => ({
    client: text(row.client, 80),
    count: nonNegativeInteger(row.count),
    family: text(row.family, 40),
    first_seen: text(row.first_seen, 40),
    last_seen: text(row.last_seen, 40),
    method: text(row.method, 20),
    path: text(row.path, 160),
    status: nonNegativeInteger(row.status),
    surface: text(row.surface, 40),
  }));
}

function recordLegacyCompatibilityUsage(database: RunnerDatabase, input: {
  client: string;
  family: LegacyFamily;
  method: string;
  path: string;
  status: number;
  surface: string;
  target: string;
}): void {
  if (database.readonly) return;
  try {
    database.sqlite.run(`insert into pi_action_events (
      action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
      reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at
    ) values (?, '', 0, '', ?, ?, 'observe', ?, ?, ?, '', '', '', ?)`, [
      `legacy-compat:${randomID()}`,
      LEGACY_USAGE_EVENT,
      input.client,
      `${input.family} compatibility usage`,
      JSON.stringify({
        client: input.client,
        compat_version: LEGACY_COMPATIBILITY_CONTRACT,
        family: input.family,
        method: input.method,
        path: input.path,
        surface: input.surface,
        target: input.target,
      }),
      JSON.stringify({ status: input.status }),
      new Date().toISOString(),
    ]);
  } catch {
    // Telemetry must never change the compatibility response or route redirect.
  }
}

function apiFamily(path: string): LegacyFamily | null {
  for (const [family, policy] of Object.entries(LEGACY_FAMILIES) as Array<[LegacyFamily, typeof LEGACY_FAMILIES[LegacyFamily]]>) {
    if (policy.path.test(path)) return family;
  }
  return null;
}

function normalizedApiPath(family: LegacyFamily, path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (family === "sessions" && segments[2] === "preferences") return "/api/sessions/preferences";
  if (segments.length < 3) return `/api/${family}`;
  return [`/api/${family}/:id`, ...segments.slice(3)].join("/");
}

function requestClient(request: Request): string {
  const explicit = text(request.headers.get("x-codex-client"), 80);
  if (explicit) return explicit;
  const userAgent = text(request.headers.get("user-agent"), 120).toLowerCase();
  if (userAgent.includes("curl")) return "curl";
  if (userAgent.includes("mozilla")) return "browser-unknown";
  return "http-unknown";
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const value = await parseJsonBody(request);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "请求体必须是 JSON object");
  return value as Record<string, unknown>;
}

function legacyFamily(value: unknown): LegacyFamily {
  const family = text(value, 40);
  if (family === "issues" || family === "sessions") return family;
  throw new HttpError(400, "family 必须是 issues 或 sessions");
}

function text(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function randomID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
