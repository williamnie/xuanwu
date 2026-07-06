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
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";
import { createPiRuntimeToolKit, recordPiRuntimeToolRegistryAudit } from "../pi/piRuntimeTools.ts";

export type PiRuntimeResult = { piSessionId: string; sessionFile: string };
export type PiRuntimeSession = Awaited<ReturnType<typeof createPiRuntimeSession>>;
export type RuntimeSessionInput = {
  agent: PiAgent;
  authorization?: PiGatePolicy;
  bus?: EventBus;
  conversationID: string;
  delegationID?: string;
  heartbeatID?: string;
  issueID?: number;
  onIssueEnqueued?: (projectID: string) => void;
  project?: Project;
  sessionFile?: string;
  source?: string;
  toolProject?: Project;
};

export const PI_RUNNER_CHAT_ACTIONS = [
  ...PI_SAFE_ACTION_TYPES,
  "issue.create",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel"
] as const;

export const PI_RUNNER_CHAT_MUTATION_ACTIONS = [
  "issue.create",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel"
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
  const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot(context.cwd));
  const paths = piRuntimePaths(db);
  await mkdir(dirname(paths.authPath), { recursive: true });
  await mkdir(context.sessionDir, { recursive: true });

  const authStorage = sdk.pi.AuthStorage.create(paths.authPath);
  const modelRegistry = sdk.pi.ModelRegistry.create(authStorage, paths.modelsPath);
  const sessionManager = input.sessionFile
    ? sdk.pi.SessionManager.open(input.sessionFile, context.sessionDir, context.cwd)
    : sdk.pi.SessionManager.create(context.cwd, context.sessionDir, { id: input.conversationID });
  const cleanupRuntimeProvider = ensureRuntimeProvider(sdk, input.agent);
  const toolContext = {
    authorization: input.authorization,
    bus: input.bus,
    conversationID: input.conversationID,
    delegationID: input.delegationID,
    heartbeatID: input.heartbeatID,
    onIssueEnqueued: input.onIssueEnqueued,
    source: input.source
  };
  const runtimeTools = createPiRuntimeToolKit(db, toolProject, toolContext);
  recordPiRuntimeToolRegistryAudit(db, {
    conversationID: input.conversationID,
    delegationID: input.delegationID,
    heartbeatID: input.heartbeatID,
    issueID: input.issueID,
    projectID: toolProject?.id ?? input.project?.id
  }, runtimeTools.audit);
  try {
    const { session } = await sdk.pi.createAgentSession({
      cwd: context.cwd,
      agentDir: paths.agentDir,
      authStorage,
      model: resolvePiModel(modelRegistry, input.agent),
      modelRegistry,
      resourceLoader: emptyResourceLoader(sdk, input, db),
      sessionManager,
      settingsManager: sdk.pi.SettingsManager.create(context.cwd, paths.agentDir),
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
      projectID: toolProject?.id ?? input.project?.id
    });
    if (input.agent.name !== "") session.setSessionName(input.agent.name);
    return { session, dispose: () => disposePiRuntimeSession(session, cleanupRuntimeProvider, cleanupSdkAudit) };
  } catch (error) {
    cleanupRuntimeProvider();
    throw error;
  }
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

function emptyResourceLoader(sdk: SmokeRuntime, input: RuntimeSessionInput, db: RunnerDatabase) {
  const systemPrompt = buildPiRuntimeSystemPrompt(input, db);
  return {
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getAppendSystemPrompt: () => [],
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.pi.createExtensionRuntime() }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getSystemPrompt: () => systemPrompt,
    getThemes: () => ({ themes: [], diagnostics: [] }),
    extendResources: () => {},
    reload: async () => {}
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
  if (agent.model_provider === "" || agent.model_id === "") return undefined;
  const model = modelRegistry.find(agent.model_provider, agent.model_id);
  if (!model) return undefined;
  return withBuiltInModelMetadata(model, agent);
}

function withBuiltInModelMetadata(model: Model<any>, agent: PiAgent): Model<any> {
  const provider = knownModelProvider(agent.model_provider);
  if (!provider) return model;
  const builtIn = getModel(provider, agent.model_id as never);
  if (!builtIn || !isDefaultCustomModelMetadata(model)) return model;
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
