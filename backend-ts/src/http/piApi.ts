import type { RunnerDatabase } from "../db/database.ts";
import type { RunnerConfig } from "../config/env.ts";
import { DEFAULT_PI_AGENT_ID, ensureDefaultPiAgent } from "../db/defaultPiAgent.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  createProjectPiSettings,
  getPiAgent,
  getProjectPiSettings,
  listPiAgents,
  listProjectPiSettings,
  updatePiAgent,
  updateProjectPiSettings,
  type ProjectPiSettings
} from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { registerPiActionProposalRoutes } from "./piActionProposalsApi.ts";
import { registerPiActivityRoutes } from "./piActivityApi.ts";
import { registerPiActionRoutes } from "./piActionsApi.ts";
import { registerPiAttentionInboxRoutes } from "./piAttentionInboxApi.ts";
import { registerPiAutomationRoutes } from "./piAutomationsApi.ts";
import { registerPiApprovalRequestRoutes } from "./piApprovalRequestsApi.ts";
import { registerPiConversationRoutes } from "./piConversationApi.ts";
import { registerPiConnectorHealthRoutes } from "./piConnectorHealthApi.ts";
import { registerPiDelegationRoutes } from "./piDelegationsApi.ts";
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
import { registerPiIssueCompletionWatchRoutes } from "./piIssueCompletionWatchesApi.ts";
import { registerPiGuardianAlertRoutes } from "./piGuardianAlertsApi.ts";
import { registerPiReportRoutes } from "./piReportsApi.ts";
import { registerPiSourcePolicyRoutes } from "./piSourcePoliciesApi.ts";
import { registerPiSkillRoutes } from "./piSkillsApi.ts";
import { registerPiToolRegistryRoutes } from "./piToolRegistryApi.ts";
import { piRuntimePromptSummary } from "./piRuntimePrompt.ts";
import type { Router } from "./router.ts";

type PiApiContext = {
  bus?: EventBus;
  codexSessionsDir?: string;
  config?: RunnerConfig;
  database: RunnerDatabase;
  piOpenAICodexOAuthLogin?: PiOpenAICodexOAuthLogin;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  webhookSigningSecret?: string;
};

type SettingsPatch = Partial<Pick<ProjectPiSettings,
  "auto_enqueue" | "auto_manage" | "auto_triage" | "max_actions_per_cycle" |
  "notify_on_needs_user" | "pi_agent_id"
>>;

export function registerPiRoutes(router: Router, context: PiApiContext): void {
  router.get("/api/pi/agents", () => piAgentListResponse(context));
  router.get("/api/pi/agents/:id", (request) => piAgentResponse(context, request));
  router.get("/api/pi/agents/:id/runtime-prompt", (request) => piAgentPromptResponse(context, request));
  router.patch("/api/pi/agents/:id", (request) => patchPiAgentResponse(context, request));
  registerPiActionProposalRoutes(router, context);
  registerPiActivityRoutes(router, context);
  registerPiActionRoutes(router, context);
  registerPiAttentionInboxRoutes(router, context);
  registerPiAutomationRoutes(router, context);
  registerPiApprovalRequestRoutes(router, context);
  registerPiConnectorHealthRoutes(router, context);
  registerPiConversationRoutes(router, context);
  registerPiDelegationRoutes(router, context);
  registerPiMaintenanceRoutes(router, context);
  registerPiMemoryRoutes(router, context);
  registerPiMcpDiscoveryRoutes(router, context);
  registerPiMcpRegistryRoutes(router, context);
  registerPiOAuthRoutes(router, context);
  registerPiProjectPolicyRoutes(router, context);
  registerPiProviderSettingsRoutes(router, context);
  registerPiProjectControlRoutes(router, context);
  registerPiGuardianRoutes(router, context);
  registerPiIssueCompletionWatchRoutes(router, context);
  registerPiGuardianAlertRoutes(router, context);
  registerPiHeartbeatRoutes(router, context);
  registerPiHeartbeatTimelineRoutes(router, context);
  registerPiReportRoutes(router, context);
  registerPiSourcePolicyRoutes(router, context);
  registerPiSkillRoutes(router, context);
  registerPiToolRegistryRoutes(router, context);
  router.get("/api/projects/:id/pi-settings", (request) => projectPiSettingsResponse(context, request));
  router.patch("/api/projects/:id/pi-settings", (request) => patchProjectPiSettingsResponse(context, request));
}

function piAgentListResponse(context: PiApiContext): Response {
  ensureDefaultPiAgent(context.database);
  return json(listPiAgents(context.database));
}

function piAgentResponse(context: PiApiContext, request: Request): Response {
  ensureDefaultPiAgent(context.database);
  const agent = getPiAgent(context.database, piAgentID(request));
  if (!agent) throw new HttpError(404, "资源不存在");
  return json(agent);
}

function piAgentPromptResponse(context: PiApiContext, request: Request): Response {
  ensureDefaultPiAgent(context.database);
  const agent = getPiAgent(context.database, piAgentID(request));
  if (!agent) throw new HttpError(404, "资源不存在");
  return json({
    agent_id: agent.id,
    agent_name: agent.name,
    runtime_prompt_summary: piRuntimePromptSummary(agent)
  });
}

async function patchPiAgentResponse(context: PiApiContext, request: Request): Promise<Response> {
  ensureDefaultPiAgent(context.database);
  const id = piAgentID(request);
  if (!getPiAgent(context.database, id)) throw new HttpError(404, "资源不存在");
  const body = normalizeAgentInput(await parseObjectBody(request));
  if (inputDisablesAgent(body)) assertAgentCanBeDisabled(context.database, id);
  return writeResponse(() => updatePiAgent(context.database, id, body));
}

function projectPiSettingsResponse(context: PiApiContext, request: Request): Response {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  return json(readProjectPiSettings(context.database, id));
}

async function patchProjectPiSettingsResponse(context: PiApiContext, request: Request): Promise<Response> {
  const id = projectID(request);
  assertProjectExists(context.database, id);
  const current = getProjectPiSettings(context.database, id);
  const patch = normalizeSettingsPatch(await parseObjectBody(request));
  const next = { ...defaultProjectPiSettings(context.database, id), ...current, ...patch };
  assertSettingsCanUseAgent(context.database, next);
  return writeResponse(() => current
    ? updateProjectPiSettings(context.database, id, patch)
    : createProjectPiSettings(context.database, { ...next, project_id: id }));
}

function readProjectPiSettings(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return getProjectPiSettings(db, projectID) ?? defaultProjectPiSettings(db, projectID);
}

function defaultProjectPiSettings(db: RunnerDatabase, projectID: string): ProjectPiSettings {
  return {
    project_id: projectID,
    pi_agent_id: defaultPiAgentID(db),
    auto_manage: 0,
    auto_triage: 0,
    auto_enqueue: 0,
    notify_on_needs_user: 1,
    max_actions_per_cycle: 5,
    created_at: "",
    updated_at: ""
  };
}

function normalizeAgentInput(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  if (hasValue(normalized, "enabled")) normalized.enabled = integerFlag(normalized.enabled);
  if (hasValue(normalized, "tools_json")) normalized.tools_json = jsonInput(normalized.tools_json, "[]");
  return normalized;
}

function normalizeSettingsPatch(input: Record<string, unknown>): SettingsPatch {
  const patch: SettingsPatch = {};
  if (hasValue(input, "pi_agent_id")) patch.pi_agent_id = cleanString(input.pi_agent_id);
  for (const field of BOOLEAN_SETTINGS_FIELDS) {
    if (hasValue(input, field)) patch[field] = integerFlag(input[field]);
  }
  if (hasValue(input, "max_actions_per_cycle")) {
    patch.max_actions_per_cycle = positiveInteger(input.max_actions_per_cycle, 5);
  }
  return patch;
}

function assertSettingsCanUseAgent(db: RunnerDatabase, settings: ProjectPiSettings): void {
  if (settings.pi_agent_id === "") {
    if (hasAutoSetting(settings)) throw new HttpError(400, "PI agent 不存在");
    return;
  }
  const agent = getPiAgent(db, settings.pi_agent_id);
  if (!agent) throw new HttpError(400, "PI agent 不存在");
  if (hasAutoSetting(settings) && agent.enabled !== 1) {
    throw new HttpError(400, "disabled PI agent cannot be used automatically");
  }
}


function assertAgentCanBeDisabled(db: RunnerDatabase, id: string): void {
  if (agentHasAutoSettings(db, id)) {
    throw new HttpError(400, "enabled=false would disable an automatically managed PI agent");
  }
}

function agentHasAutoSettings(db: RunnerDatabase, id: string): boolean {
  return listProjectPiSettings(db).some((settings) => (
    settings.pi_agent_id === id && hasAutoSetting(settings)
  ));
}

const BOOLEAN_SETTINGS_FIELDS = [
  "auto_manage",
  "auto_triage",
  "auto_enqueue",
  "notify_on_needs_user"
] as const;

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

function defaultPiAgentID(db: RunnerDatabase): string {
  ensureDefaultPiAgent(db);
  const agents = listPiAgents(db);
  return agents.find((agent) => agent.id === DEFAULT_PI_AGENT_ID)?.id
    ?? agents.find((agent) => agent.enabled === 1)?.id
    ?? "";
}

function inputDisablesAgent(input: Record<string, unknown>): boolean {
  return hasValue(input, "enabled") && integerFlag(input.enabled) === 0;
}

function hasAutoSetting(settings: Pick<ProjectPiSettings, "auto_enqueue" | "auto_manage" | "auto_triage">): boolean {
  return settings.auto_manage !== 0 || settings.auto_triage !== 0 || settings.auto_enqueue !== 0;
}

function assertProjectExists(db: RunnerDatabase, id: string): void {
  if (!getProject(db, id)) throw new HttpError(404, "资源不存在");
}

function piAgentID(request: Request): string {
  return pathPart(request, "agents");
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

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
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
