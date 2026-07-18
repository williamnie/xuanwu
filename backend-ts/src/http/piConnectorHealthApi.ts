import type { RunnerConfig } from "../config/env.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import {
  buildConnectorDiagnosticBundle,
  buildStaticConnectorDiagnostics,
  connectorTestHistory,
  probeConnectorConnection,
  type ConnectorProbeResult
} from "../integrations/connectorDiagnostics.ts";
import { browserConnectorHealth } from "../pi/browserConnectorHealth.ts";
import { checkCliConnectorHealth } from "../pi/cliConnectorHealth.ts";
import { SecretStoreError } from "../security/secrets/contracts.ts";
import { createDatabaseSecretService, type SecretService } from "../security/secrets/service.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiConnectorHealthContext = {
  config?: RunnerConfig;
  database: RunnerDatabase;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  secrets?: SecretService;
  webhookSigningSecret?: string;
};

export function registerPiConnectorHealthRoutes(router: Router, context: PiConnectorHealthContext): void {
  const active = { ...context, secrets: context.secrets ?? createDatabaseSecretService(context.database) };
  router.get("/api/pi/connectors", () => connectorHealthResponse(active));
  router.get("/api/pi/connectors/health", () => connectorHealthResponse(active));
  router.get("/api/pi/connectors/diagnostics", () => connectorDiagnosticResponse(active));
  router.post("/api/pi/connectors/:id/test-connection", (request) => testConnectionResponse(active, request));
  router.post("/api/pi/connectors/:id/revoke", (request) => revokeResponse(active, request));
}

async function connectorHealthResponse(context: PiConnectorHealthContext): Promise<Response> {
  const report = await connectorReport(context, true);
  return json(report);
}

async function connectorDiagnosticResponse(context: PiConnectorHealthContext): Promise<Response> {
  const cli = await checkCliConnectorHealth({
    env: context.env,
    manifestDirs: context.config?.cliConnectors.manifestDirs ?? [],
    probe: false
  });
  return json(buildConnectorDiagnosticBundle(requiredContext(context), [
    browserConnectorHealth(context.env),
    ...cli.connectors.map((item) => withAuditBackoff(context, item))
  ], cli.diagnostics));
}

async function testConnectionResponse(context: PiConnectorHealthContext, request: Request): Promise<Response> {
  const id = connectorID(request);
  const now = context.now?.() ?? new Date();
  const history = connectorTestHistory(context.database, id, now);
  if (history.blocked) throw new HttpError(429, `connector test backoff is active until ${history.retry_at}`);
  const body = await objectBody(request);
  const started = Date.now();
  const result = await probeByID(context, id);
  createPiActionEvent(context.database, {
    action_id: `connector-test:${id}:${crypto.randomUUID()}`,
    actor: text(body.actor) || "user",
    event_type: "connector.tested",
    payload_json: JSON.stringify({ connector_id: id }),
    reason: text(body.reason) || "user requested connector test",
    result_json: JSON.stringify({ ...result, duration_ms: Math.max(0, Date.now() - started) }),
    error: result.error?.code ?? ""
  });
  return json({ connector_id: id, result, backoff: connectorTestHistory(context.database, id, now) });
}

async function revokeResponse(context: PiConnectorHealthContext, request: Request): Promise<Response> {
  const id = connectorID(request);
  const body = await objectBody(request);
  const ref = text(body.secret_ref ?? body.secretRef);
  const reason = text(body.reason);
  if (ref === "") throw new HttpError(400, "secret_ref is required");
  if (reason === "") throw new HttpError(400, "reason is required");
  const connector = staticConnector(context, id);
  const secret = secretReference(connector, ref);
  if (!secret) throw new HttpError(400, "secret_ref is not declared by this connector");
  if (secret.revocable !== true) throw new HttpError(400, "secret_ref is not revocable by Runner");
  try {
    const metadata = context.secrets!.revoke(ref, text(body.actor) || "user", reason);
    clearRuntimeSecret(context.config, id, String(secret.name ?? ""));
    return json({ connector_id: id, secret: metadata, health: staticConnector(context, id) });
  } catch (error) {
    if (error instanceof SecretStoreError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function connectorReport(context: PiConnectorHealthContext, probe: boolean): Promise<Record<string, unknown>> {
  const cli = await checkCliConnectorHealth({
    env: context.env,
    manifestDirs: context.config?.cliConnectors.manifestDirs ?? [],
    probe
  });
  const connectors = context.config
    ? [...buildStaticConnectorDiagnostics(requiredContext(context)), browserConnectorHealth(context.env), ...cli.connectors.map((item) => withAuditBackoff(context, item))]
    : [browserConnectorHealth(context.env), ...cli.connectors.map((item) => withAuditBackoff(context, item))];
  return {
    schema_version: "xuanwu.connector-health.v1",
    connectors,
    diagnostics: cli.diagnostics,
    generated_at: (context.now?.() ?? new Date()).toISOString()
  };
}

async function probeByID(context: PiConnectorHealthContext, id: string): Promise<ConnectorProbeResult> {
  if (context.config) {
    const connector = buildStaticConnectorDiagnostics(requiredContext(context)).find((item) => item.id === id);
    if (connector) {
      const test = connector.test_connection as { supported?: boolean } | undefined;
      if (test?.supported !== true) throw new HttpError(400, "connector test is not supported");
      return probeConnectorConnection({
        config: context.config,
        connectorID: id,
        now: context.now,
        webhookSigningSecret: context.webhookSigningSecret
      });
    }
  }
  const cli = await checkCliConnectorHealth({
    connectorID: id,
    env: context.env,
    manifestDirs: context.config?.cliConnectors.manifestDirs ?? [],
    probe: true
  });
  const cliConnector = cli.connectors.find((item) => item.id === id);
  if (cliConnector) return cliProbeResult(cliConnector, context.now?.() ?? new Date());
  if (!context.config) return unavailable("not_configured", "Connector configuration is unavailable", context.now?.() ?? new Date());
  throw new HttpError(404, "connector not found");
}

function cliProbeResult(connector: Record<string, unknown>, now: Date): ConnectorProbeResult {
  const health = object(connector.health);
  const error = object(health.error);
  const ok = health.ok === true;
  return {
    checked_at: text(health.checked_at) || now.toISOString(),
    ...(ok ? {} : { error: { code: text(error.code) || "connector_test_failed", message: text(error.message) || "CLI connector test failed" } }),
    ok,
    state: ok ? "healthy" : text(error.exit_category) === "auth_required" ? "degraded" : "failed"
  };
}

function staticConnector(context: PiConnectorHealthContext, id: string): Record<string, unknown> {
  if (!context.config) throw new HttpError(404, "connector not found");
  const connector = buildStaticConnectorDiagnostics(requiredContext(context)).find((item) => item.id === id);
  if (!connector) throw new HttpError(404, "connector not found");
  return connector;
}

function secretReference(connector: Record<string, unknown>, ref: string): Record<string, unknown> | null {
  const refs = Array.isArray(connector.secret_refs) ? connector.secret_refs : [];
  return refs.find((item) => object(item).ref === ref) as Record<string, unknown> | undefined ?? null;
}

function clearRuntimeSecret(config: RunnerConfig | undefined, connectorID: string, name: string): void {
  if (!config) return;
  if (connectorID === "feishu") {
    if (name === "app_secret") config.integrations.feishu.appSecret = "";
    if (name === "verification_token") config.integrations.feishu.verificationToken = "";
    if (name === "encrypt_key") config.integrations.feishu.encryptKey = "";
    return;
  }
  if (connectorID.startsWith("github-")) config.integrations.github.token = "";
  if (connectorID.startsWith("gitlab-")) config.integrations.gitlab.token = "";
}

function withAuditBackoff(context: PiConnectorHealthContext, connector: Record<string, unknown>): Record<string, unknown> {
  const history = connectorTestHistory(context.database, text(connector.id), context.now?.() ?? new Date());
  return {
    ...connector,
    health: {
      ...object(connector.health),
      backoff: { attempt: history.attempts, blocked: history.blocked, retry_at: history.retry_at }
    }
  };
}

function requiredContext(context: PiConnectorHealthContext): {
  config: RunnerConfig;
  database: RunnerDatabase;
  now?: () => Date;
  secrets?: SecretService;
  webhookSigningSecret?: string;
} {
  if (!context.config) throw new HttpError(503, "connector configuration is unavailable");
  return context as ReturnType<typeof requiredContext>;
}

async function objectBody(request: Request): Promise<Record<string, unknown>> {
  const raw = await parseJsonBody(request);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function connectorID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  return decodeURIComponent(parts[parts.indexOf("connectors") + 1] ?? "").trim();
}

function unavailable(code: string, message: string, now: Date): ConnectorProbeResult {
  return { checked_at: now.toISOString(), error: { code, message }, ok: false, state: "unconfigured" };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
