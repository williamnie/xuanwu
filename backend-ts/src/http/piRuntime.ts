import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import type { PiAgent, PiConversation } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { createPiProjectTools, PI_ALLOWED_TOOLS } from "./piProjectTools.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot, type SmokeRuntime } from "../spikes/piSmokeSupport.ts";

export type PiRuntimeResult = { piSessionId: string; sessionFile: string };
export type PiRuntimeSession = Awaited<ReturnType<typeof createPiRuntimeSession>>;
export type RuntimeSessionInput = {
  agent: PiAgent;
  conversationID: string;
  project: Project;
  sessionFile?: string;
};

const PI_RUNTIME_ROOT = "pi-runtime";
const PI_AGENT_DIR = "agent";
const PI_SESSIONS_DIR = "sessions";

export async function createOrRestorePiRuntime(
  db: RunnerDatabase,
  input: RuntimeSessionInput
): Promise<PiRuntimeResult> {
  const runtime = await createPiRuntimeSession(db, input);
  await ensurePiSessionFile(runtime.session);
  runtime.session.dispose();
  return {
    piSessionId: runtime.session.sessionId,
    sessionFile: runtime.session.sessionFile ?? ""
  };
}

export async function createPiRuntimeSession(db: RunnerDatabase, input: RuntimeSessionInput) {
  const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
  const paths = piRuntimePaths(db);
  await mkdir(dirname(paths.authPath), { recursive: true });
  await mkdir(paths.sessionDir, { recursive: true });

  const authStorage = sdk.pi.AuthStorage.create(paths.authPath);
  const modelRegistry = sdk.pi.ModelRegistry.create(authStorage, paths.modelsPath);
  const sessionManager = input.sessionFile
    ? sdk.pi.SessionManager.open(input.sessionFile, paths.sessionDir, input.project.cwd)
    : sdk.pi.SessionManager.create(input.project.cwd, paths.sessionDir, { id: input.conversationID });
  const { session } = await sdk.pi.createAgentSession({
    cwd: input.project.cwd,
    agentDir: paths.agentDir,
    authStorage,
    model: resolvePiModel(modelRegistry, input.agent),
    modelRegistry,
    resourceLoader: emptyResourceLoader(sdk),
    sessionManager,
    settingsManager: sdk.pi.SettingsManager.create(input.project.cwd, paths.agentDir),
    thinkingLevel: normalizeThinkingLevel(input.agent.thinking_level),
    tools: [...PI_ALLOWED_TOOLS],
    customTools: createPiProjectTools(db, input.project)
  });
  if (input.agent.name !== "") session.setSessionName(input.agent.name);
  return { session };
}

export function publishPiSessionEvent(
  bus: EventBus | undefined,
  conversation: PiConversation,
  event: AgentSessionEvent
): void {
  bus?.publish(piAppEvent(conversation, event));
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
    modelsPath: join(agentDir, "models.json"),
    sessionDir: join(stateDir, PI_RUNTIME_ROOT, PI_SESSIONS_DIR)
  };
}

function emptyResourceLoader(sdk: SmokeRuntime) {
  return {
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getAppendSystemPrompt: () => [],
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.pi.createExtensionRuntime() }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getSystemPrompt: () => "You are PI, an independent project manager agent for codex-issue-runner.",
    getThemes: () => ({ themes: [], diagnostics: [] }),
    extendResources: () => {},
    reload: async () => {}
  };
}

function piAppEvent(conversation: PiConversation, event: AgentSessionEvent): AppEvent {
  return {
    type: "pi.conversation.event",
    conversationId: conversation.id,
    projectId: conversation.project_id,
    provider: "pi-sdk",
    agent_event_type: event.type,
    status: piEventStatus(event),
    text: piEventText(event),
    payload: JSON.stringify(piEventPayload(event)),
    created_at: new Date().toISOString()
  };
}

function piEventStatus(event: AgentSessionEvent): string {
  if (event.type === "agent_start") return "running";
  if (event.type === "agent_end") return event.willRetry ? "retrying" : "completed";
  if (event.type === "message_update" && event.message.errorMessage) return "failed";
  return "";
}

function piEventText(event: AgentSessionEvent): string {
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    if ("delta" in assistantEvent) return assistantEvent.delta;
    if ("content" in assistantEvent) return assistantEvent.content;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    return collectTextContent(event.message.content);
  }
  return "";
}

function piEventPayload(event: AgentSessionEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: event.type };
  if (event.type === "message_start" || event.type === "message_end") payload.role = event.message.role;
  if (event.type === "message_update") {
    payload.role = event.message.role;
    payload.assistant_event_type = event.assistantMessageEvent.type;
  }
  if (isToolEvent(event)) {
    payload.tool_call_id = event.toolCallId;
    payload.tool_name = event.toolName;
  }
  if (event.type === "tool_execution_end") payload.is_error = event.isError;
  return payload;
}

function collectTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

type PiToolEvent = Extract<AgentSessionEvent, {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}>;

function isToolEvent(event: AgentSessionEvent): event is PiToolEvent {
  return ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type);
}

type PiModelRegistry = { find(provider: string, modelID: string): Model<any> | undefined };

function resolvePiModel(modelRegistry: PiModelRegistry, agent: PiAgent) {
  if (agent.model_provider === "" || agent.model_id === "") return undefined;
  return modelRegistry.find(agent.model_provider, agent.model_id);
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
