import type { RunnerDatabase } from "../db/database.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import type { RunnerConfig } from "../config/env.ts";
import { DEFAULT_PI_AGENT_ID, ensureDefaultPiAgent } from "../db/defaultPiAgent.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  deleteProjectPiSettings,
  getPiSupervisor,
  getProjectPiSettings,
  listProjectPiSettings,
  updatePiSupervisor,
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { registerPiActionProposalRoutes } from "./piActionProposalsApi.ts";
import { registerPiActivityRoutes } from "./piActivityApi.ts";
import { registerPiActionRoutes } from "./piActionsApi.ts";
import { registerPiAttentionInboxRoutes } from "./piAttentionInboxApi.ts";
import { registerPiApprovalRequestRoutes } from "./piApprovalRequestsApi.ts";
import { registerPiConversationRoutes } from "./piConversationApi.ts";
import { registerPiConnectorHealthRoutes } from "./piConnectorHealthApi.ts";
import { registerPiMemoryRoutes } from "./piMemoryApi.ts";
import { registerPiMaintenanceRoutes } from "./piMaintenanceApi.ts";
import { registerPiMcpDiscoveryRoutes } from "./piMcpDiscoveryApi.ts";
import { registerPiMcpRegistryRoutes } from "./piMcpRegistryApi.ts";
import { registerPiOAuthRoutes, type PiOpenAICodexOAuthLogin } from "./piOAuthApi.ts";
import { registerPiProjectPolicyRoutes } from "./piProjectPolicyApi.ts";
import { registerPiProviderSettingsRoutes } from "./piProviderSettingsApi.ts";
import { registerPiProjectControlRoutes } from "./piProjectControlApi.ts";
import { registerPiHeartbeatRoutes } from "./piHeartbeatApi.ts";
import { registerPiHeartbeatTimelineRoutes } from "./piHeartbeatTimelineApi.ts";
import { registerPiGuardianRoutes } from "./piGuardianApi.ts";
import { registerPiGuardianAlertRoutes } from "./piGuardianAlertsApi.ts";
import { registerPiReportRoutes } from "./piReportsApi.ts";
import { registerPiSourcePolicyRoutes } from "./piSourcePoliciesApi.ts";
import { registerPiSkillRoutes } from "./piSkillsApi.ts";
import { registerPiToolRegistryRoutes } from "./piToolRegistryApi.ts";
import { piRuntimePromptSummary } from "./piRuntimePrompt.ts";
import type { Router } from "./router.ts";
import { bindProjectAutomaticTakeover } from "../domain/project/automaticTakeover.ts";

type PiApiContext = {
  agenticClient?: AgenticWorkerClient;
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  webhookSigningSecret?: string;
};

export function registerPiRoutes(router: Router, context: PiApiContext): void {
  router.get("/api/pi/supervisor", () => piSupervisorResponse(context));
  router.get("/api/pi/supervisor/runtime-prompt", () => piSupervisorPromptResponse(context));
  router.patch("/api/pi/supervisor", (request) => patchPiSupervisorResponse(context, request));
  registerPiActionProposalRoutes(router, context);
  registerPiActivityRoutes(router, context);
  registerPiActionRoutes(router, context);
  registerPiAttentionInboxRoutes(router, context);
  registerPiApprovalRequestRoutes(router, context);
  registerPiConnectorHealthRoutes(router, context);
  registerPiConversationRoutes(router, context);
  registerPiMaintenanceRoutes(router, context);
  registerPiMemoryRoutes(router, context);
  registerPiMcpDiscoveryRoutes(router, context);
  registerPiMcpRegistryRoutes(router, context);
  registerPiOAuthRoutes(router, context);
  registerPiProjectPolicyRoutes(router, context);
  registerPiProviderSettingsRoutes(router, context);
  registerPiProjectControlRoutes(router, context);
  registerPiGuardianRoutes(router, context);
  registerPiGuardianAlertRoutes(router, context);
  registerPiHeartbeatRoutes(router, context);
  registerPiHeartbeatTimelineRoutes(router, context);
  registerPiReportRoutes(router, context);
  registerPiSourcePolicyRoutes(router, context);
  registerPiSkillRoutes(router, context);
  registerPiToolRegistryRoutes(router, context);
  router.get("/api/projects/:id/pi-settings", (request) => projectPiSettingsResponse(context, request));
  router.patch("/api/projects/:id/pi-settings", (request) => patchProjectPiSettingsResponse(context, request));
  router.delete("/api/projects/:id/pi-settings", (request) => deleteProjectPiSettingsResponse(context, request));
}

function piSupervisorResponse(context: PiApiContext): Response {
  ensureDefaultPiAgent(context.database);
  return json(requirePiSupervisor(context.database));
}

function piSupervisorPromptResponse(context: PiApiContext): Response {
  ensureDefaultPiAgent(context.database);
  const agent = requirePiSupervisor(context.database);
  return json({
    supervisor_name: agent.name,
    runtime_prompt_summary: piRuntimePromptSummary(agent)
  });
}

async function patchPiSupervisorResponse(context: PiApiContext, request: Request): Promise<Response> {
  ensureDefaultPiAgent(context.database);
  const body = normalizeAgentInput(await parseObjectBody(request));
  if (inputDisablesAgent(body)) assertAgentCanBeDisabled(context.database, DEFAULT_PI_AGENT_ID);
  return writeResponse(() => updatePiSupervisor(context.database, body));
}

function requirePiSupervisor(db: RunnerDatabase) {
  const supervisor = getPiSupervisor(db);
  if (!supervisor) throw new HttpError(500, "Supervisor 配置不可用");
  return supervisor;
}

function projectPiSettingsResponse(context: PiApiContext, request: Request): Response {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  return json(getProjectPiSettings(context.database, id));
}

async function patchProjectPiSettingsResponse(context: PiApiContext, request: Request): Promise<Response> {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  assertNoRemovedProjectPiSettings(await parseObjectBody(request));
  assertSupervisorCanManageProjects(context.database);
  return writeResponse(() => bindProjectAutomaticTakeover(context.database, id));
}

function assertNoRemovedProjectPiSettings(input: Record<string, unknown>): void {
  const field = REMOVED_PROJECT_PI_SETTINGS.find((key) => Object.hasOwn(input, key));
  if (field) throw new HttpError(400, `${field} 已移除；绑定项目后 Supervisor 会自动完全接管`);
}

const REMOVED_PROJECT_PI_SETTINGS = [
  "pi_agent_id",
  "auto_manage",
  "auto_triage",
  "auto_enqueue",
  "notify_on_needs_user",
  "max_actions_per_cycle"
] as const;

function deleteProjectPiSettingsResponse(context: PiApiContext, request: Request): Response {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  unbindProjectFromSupervisor(context.database, id);
  return json({ managed: false, project_id: id });
}

function unbindProjectFromSupervisor(db: RunnerDatabase, projectID: string): void {
  db.transaction(() => {
    db.sqlite.run(`update projects set auto_run=0,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=?`, [projectID]);
    deleteProjectPiSettings(db, projectID);
  }).immediate();
}

function normalizeAgentInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  if (hasValue(normalized, "enabled")) normalized.enabled = integerFlag(normalized.enabled);
  if (hasValue(normalized, "tools_json")) normalized.tools_json = jsonInput(normalized.tools_json, "[]");
  return normalized;
}

function assertSupervisorCanManageProjects(db: RunnerDatabase): void {
  ensureDefaultPiAgent(db);
  const supervisor = getPiSupervisor(db);
  if (!supervisor) throw new HttpError(500, "Supervisor 配置不可用");
  if (supervisor.enabled !== 1) throw new HttpError(400, "disabled Supervisor cannot manage projects");
}


function assertAgentCanBeDisabled(db: RunnerDatabase, id: string): void {
  if (id === DEFAULT_PI_AGENT_ID && listProjectPiSettings(db).length > 0) {
    throw new HttpError(400, "enabled=false would disable projects managed by Supervisor");
  }
}

async function writeResponse(write: () => unknown | Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await write(), { status });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error) throw new HttpError(400, error.message);
    throw error;
  }
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await parseJsonBody(request);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch (error) {
    if (error instanceof HttpError) throw new HttpError(400, "请求体不是合法 JSON");
    throw error;
  }
}

function inputDisablesAgent(input: Record<string, unknown>): boolean {
  return hasValue(input, "enabled") && integerFlag(input.enabled) === 0;
}

function assertProjectExists(db: RunnerDatabase, id: string): void {
  if (!getProject(db, id)) throw new HttpError(404, "资源不存在");
}

function projectID(request: Request): string {
  return pathPart(request, "projects");
}

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

function hasValue(input: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined;
}

function integerFlag(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isInteger(value) && value !== 0 ? 1 : 0;
}

function jsonInput(value: unknown, fallback: string): string {
  const text = cleanString(value);
  if (text !== "") return text;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
