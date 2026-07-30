import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getModel, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import type { PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { PiGatePolicy } from "../pi/actionGate.ts";
import { PI_SAFE_ACTION_TYPES } from "../pi/actionGate.ts";
import type { EventBus } from "../events/bus.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot, type SmokeRuntime } from "../spikes/piSmokeSupport.ts";
import { installPiSdkToolAudit } from "./piSdkToolAudit.ts";
import { createPiRuntimeResourceLoader } from "./piRuntimeResources.ts";
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";
import {
  createPiRuntimeToolKit,
  recordPiRuntimeToolRegistryAudit,
  unavailablePiRuntimeToolRegistryAudit
} from "../pi/piRuntimeTools.ts";
import type { SupervisorContextResolution } from "../pi/supervisorContextResolver.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES } from "../pi/supervisorControlContracts.ts";
import { installPiProviderSecretOverride } from "../security/secrets/piProviderRuntime.ts";

export type PiRuntimeResult = { piSessionId: string; sessionFile: string };
export type PiRuntimeSession = Awaited<ReturnType<typeof createPiRuntimeSession>>;
export type RuntimeSessionInput = {
  agent: PiAgent;
  authorization?: PiGatePolicy;
  bus?: EventBus;
  channelContext?: string;
  cliConnectorDirs?: string[];
  conversationID: string;
  delegationID?: string;
  env?: Record<string, string | undefined>;
  heartbeatID?: string;
  issueID?: number;
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  retry?: {
    baseDelayMs?: number;
    enabled?: boolean;
    maxRetries?: number;
    provider?: { maxRetries?: number; maxRetryDelayMs?: number; timeoutMs?: number };
  };
  sessionFile?: string;
  source?: string;
  sourceTurn?: { id?: string; source?: string; userPrompt?: string };
  supervisorContext?: SupervisorContextResolution;
  toolProject?: Project;
};

export const PI_RUNNER_CHAT_ACTIONS = [
  ...PI_SAFE_ACTION_TYPES,
  "agent.workflow_request",
  "issue.create",
  "issue.cancel",
  "issue.completion_reconcile",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.status_update",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel",
  "notification.preference.update",
  "project.create",
  "workspace.make_directory",
  "workspace.write_file",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES
] as const;

export const PI_RUNNER_CHAT_MUTATION_ACTIONS = [
  "agent.workflow_request",
  "issue.create",
  "issue.cancel",
  "issue.completion_reconcile",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.status_update",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel",
  "notification.preference.update",
  "project.create",
  "workspace.make_directory",
  "workspace.write_file",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES
] as const;

const PI_RUNTIME_ROOT = "pi-runtime";
const PI_AGENT_DIR = "agent";
const RUNNER_RUNTIME_ROOT = ".runner";
const RUNNER_SESSIONS_DIR = "sessions";
const RUNNER_AGENT_DIR = "runner";
const PI_SMOKE_FAUX_PROVIDER = "pi-smoke-faux";
const PI_SMOKE_FAUX_API = "pi-smoke-faux-api";
const PI_SMOKE_FAUX_MODEL = "faux-1";
const PI_SMOKE_FAUX_RESPONSE = "pi-smoke-response-ok";

type RuntimeCleanup = () => void;

export async function createOrRestorePiRuntime(
  db: RunnerDatabase,
  input: RuntimeSessionInput
): Promise<PiRuntimeResult> {
  const runtime = await createPiRuntimeSession(db, input);
  try {
    await ensurePiSessionFile(runtime.session);
    return {
      piSessionId: runtime.session.sessionId,
      sessionFile: runtime.session.sessionFile ?? ""
    };
  } finally {
    runtime.dispose();
  }
}

export async function createPiRuntimeSession(db: RunnerDatabase, input: RuntimeSessionInput) {
  const context = runtimeContext(db, input.project);
  const toolProject = input.toolProject ?? input.project;
  const runtimeRoot = resolveDefaultRepoRoot(context.cwd);
  const sdk = await loadSmokeRuntime(runtimeRoot);
  const paths = piRuntimePaths(db);
  await mkdir(dirname(paths.authPath), { recursive: true });
  await mkdir(context.sessionDir, { recursive: true });

  const authStorage = sdk.pi.AuthStorage.create(paths.authPath);
  installPiProviderSecretOverride(authStorage, paths.modelsPath, dirname(db.path), input.agent.model_provider);
  const modelRegistry = sdk.pi.ModelRegistry.create(authStorage, paths.modelsPath);
  const settingsManager = sdk.pi.SettingsManager.create(context.cwd, paths.agentDir);
  const model = resolvePiModel(modelRegistry, input.agent);
  settingsManager.applyOverrides({
    compaction: piRuntimeCompactionSettings(model),
    ...(input.retry ? { retry: input.retry } : {})
  });
  const sessionManager = input.sessionFile
    ? sdk.pi.SessionManager.open(input.sessionFile, context.sessionDir, context.cwd)
    : sdk.pi.SessionManager.create(context.cwd, context.sessionDir, { id: input.conversationID });
  const cleanupRuntimeProvider = ensureRuntimeProvider(sdk, input.agent);
  const toolContext = {
    authorization: input.authorization,
    bus: input.bus,
    cliConnectorDirs: input.cliConnectorDirs,
    conversationID: input.conversationID,
    delegationID: input.delegationID,
    env: input.env,
    heartbeatID: input.heartbeatID,
    issueID: input.issueID,
    onIssueEnqueued: input.onIssueEnqueued,
    providers: input.providers,
    source: input.source,
    sourceTurn: input.sourceTurn
  };
  const toolAuditInput = {
    conversationID: input.conversationID,
    delegationID: input.delegationID,
    heartbeatID: input.heartbeatID,
    issueID: input.issueID,
    projectID: toolProject?.id ?? input.project?.id
  };
  let runtimeTools: ReturnType<typeof createPiRuntimeToolKit>;
  try {
    runtimeTools = createPiRuntimeToolKit(db, toolProject, toolContext);
    recordPiRuntimeToolRegistryAudit(db, toolAuditInput, runtimeTools.audit);
  } catch (error) {
    recordPiRuntimeToolRegistryAudit(db, toolAuditInput, unavailablePiRuntimeToolRegistryAudit(error));
    cleanupRuntimeProvider();
    throw new Error(`PI runtime tool registry unavailable: ${runtimeError(error)}`, { cause: error });
  }
  try {
    const resourceLoader = await createPiRuntimeResourceLoader(sdk, db, input, {
      agentDir: paths.agentDir,
      cwd: context.cwd,
      piPackageDir: process.env.PI_PACKAGE_DIR,
      runtimeRoot,
      systemPrompt: buildPiRuntimeSystemPrompt(input, db)
    });
    const { session } = await sdk.pi.createAgentSession({
      cwd: context.cwd,
      agentDir: paths.agentDir,
      authStorage,
      model,
      modelRegistry,
      resourceLoader,
      sessionManager,
      settingsManager,
      thinkingLevel: normalizeThinkingLevel(input.agent.thinking_level),
      tools: runtimeTools.tools,
      customTools: runtimeTools.customTools
    });
    const cleanupSdkAudit = installPiSdkToolAudit(db, session, {
      authorization: input.authorization,
      bus: input.bus,
      conversationID: input.conversationID,
      delegationID: input.delegationID,
      heartbeatID: input.heartbeatID,
      issueID: input.issueID,
      projectID: toolProject?.id ?? input.project?.id,
      readOnlyToolNames: runtimeTools.readOnlyToolNames,
      source: input.source
    });
    if (input.agent.name !== "") session.setSessionName(input.agent.name);
    return { session, dispose: () => disposePiRuntimeSession(session, cleanupRuntimeProvider, cleanupSdkAudit) };
  } catch (error) {
    cleanupRuntimeProvider();
    throw error;
  }
}

export function piRuntimeCompactionSettings(model: { contextWindow: number } | undefined): {
  enabled: true;
  keepRecentTokens: number;
  reserveTokens: number;
} {
  const contextWindow = positiveContextWindow(model?.contextWindow);
  if (contextWindow === 0) return { enabled: true, keepRecentTokens: 20_000, reserveTokens: 16_384 };
  const reserveTokens = Math.min(
    Math.max(4_096, Math.floor(contextWindow * 0.4)),
    Math.max(1_024, contextWindow - 1_024)
  );
  const available = Math.max(1_024, contextWindow - reserveTokens);
  return {
    enabled: true,
    keepRecentTokens: Math.min(
      20_000,
      Math.max(512, Math.floor(available * 0.25)),
      Math.max(256, available - 256)
    ),
    reserveTokens
  };
}

function positiveContextWindow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export async function ensurePiSessionFile(session: {
  sessionFile?: string;
  sessionManager: { getEntries(): unknown[]; getHeader(): unknown };
}): Promise<void> {
  const file = session.sessionFile?.trim();
  const header = session.sessionManager.getHeader();
  if (!file || !header) return;
  const entries = [header, ...session.sessionManager.getEntries()];
  await mkdir(dirname(file), { recursive: true });
  try {
    await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
  }
}

function piRuntimePaths(db: RunnerDatabase) {
  const stateDir = dirname(db.path);
  const agentDir = join(stateDir, PI_RUNTIME_ROOT, PI_AGENT_DIR);
  return {
    agentDir,
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json")
  };
}

function runtimeContext(db: RunnerDatabase, project: Project | undefined) {
  if (project) return {
    cwd: project.cwd,
    sessionDir: join(dirname(db.path), PI_RUNTIME_ROOT, "sessions")
  };
  const cwd = resolve(dirname(db.path), "..");
  return {
    cwd,
    sessionDir: join(cwd, RUNNER_RUNTIME_ROOT, RUNNER_SESSIONS_DIR, RUNNER_AGENT_DIR)
  };
}

function ensureRuntimeProvider(sdk: SmokeRuntime, agent: PiAgent): RuntimeCleanup {
  if (!isLocalSmokeFauxAgent(agent)) return noopRuntimeCleanup;
  if (sdk.ai.getApiProvider(PI_SMOKE_FAUX_API)) return noopRuntimeCleanup;

  const provider = sdk.ai.registerFauxProvider({
    api: PI_SMOKE_FAUX_API,
    provider: PI_SMOKE_FAUX_PROVIDER,
    tokensPerSecond: 0
  });
  provider.setResponses([sdk.ai.fauxAssistantMessage(PI_SMOKE_FAUX_RESPONSE)]);
  return () => provider.unregister();
}

function isLocalSmokeFauxAgent(agent: PiAgent): boolean {
  return agent.model_provider === PI_SMOKE_FAUX_PROVIDER && agent.model_id === PI_SMOKE_FAUX_MODEL;
}

function disposePiRuntimeSession(
  session: AgentSession,
  cleanupRuntimeProvider: RuntimeCleanup,
  cleanupSdkAudit: RuntimeCleanup = noopRuntimeCleanup
): void {
  try {
    cleanupSdkAudit();
    session.dispose();
  } finally {
    cleanupRuntimeProvider();
  }
}

function noopRuntimeCleanup(): void {}

type PiModelRegistry = { find(provider: string, modelID: string): Model<any> | undefined };

function resolvePiModel(modelRegistry: PiModelRegistry, agent: PiAgent) {
  if (agent.model_provider === "" || agent.model_id === "") {
    throw new Error(`PI agent ${agent.id} has no configured model provider/model`);
  }
  const model = modelRegistry.find(agent.model_provider, agent.model_id);
  if (!model) {
    throw new Error(`PI agent ${agent.id} model is unavailable: ${agent.model_provider}/${agent.model_id}`);
  }
  return piRuntimeModelMetadata(model, agent);
}

export function piRuntimeModelMetadata(model: Model<any>, agent: PiAgent): Model<any> {
  const provider = knownModelProvider(agent.model_provider);
  const defaultCustomMetadata = isDefaultCustomModelMetadata(model);
  if (provider) {
    const builtIn = getModel(provider, agent.model_id as never);
    if (builtIn && defaultCustomMetadata) {
      return {
        ...model,
        name: builtIn.name,
        reasoning: builtIn.reasoning,
        thinkingLevelMap: builtIn.thinkingLevelMap,
        input: builtIn.input,
        cost: builtIn.cost,
        contextWindow: builtIn.contextWindow,
        maxTokens: builtIn.maxTokens,
        compat: model.compat ?? builtIn.compat
      };
    }
  }
  if (defaultCustomMetadata && isCustomOpenAIGptModel(model, agent)) {
    return { ...model, input: ["text", "image"] };
  }
  return model;
}

function isCustomOpenAIGptModel(model: Model<any>, agent: PiAgent): boolean {
  return ["openai", "openai-codex"].includes(agent.model_provider) &&
    ["openai-responses", "openai-codex-responses"].includes(model.api) &&
    /^gpt(?:[-_.]|$)/i.test(agent.model_id);
}

function knownModelProvider(provider: string): KnownProvider | undefined {
  return (getProviders() as string[]).includes(provider) ? provider as KnownProvider : undefined;
}

function isDefaultCustomModelMetadata(model: Model<any>): boolean {
  return model.name === model.id &&
    model.reasoning === false &&
    model.contextWindow === 128000 &&
    model.maxTokens === 16384 &&
    model.input.length === 1 &&
    model.input[0] === "text" &&
    model.cost.input === 0 &&
    model.cost.output === 0 &&
    model.cost.cacheRead === 0 &&
    model.cost.cacheWrite === 0;
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  return isThinkingLevel(value) ? value : "medium";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function runtimeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
