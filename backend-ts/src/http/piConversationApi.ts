import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import {
  createPiConversation,
  getPiAgent,
  getPiConversation,
  listPiAgents,
  listPiConversations,
  type PiAgent,
  type PiConversation
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot, type SmokeRuntime } from "../spikes/piSmokeSupport.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiConversationContext = { database: RunnerDatabase };
type PiRuntimeResult = { piSessionId: string; sessionFile: string };
type RuntimeSessionInput = { agent: PiAgent; conversationID: string; project: Project; sessionFile?: string };

const PI_SESSION_PROVIDER = "pi-sdk";
const PI_SESSION_ROLE = "pi_manager";
const PI_RUNTIME_ROOT = "pi-runtime";
const PI_AGENT_DIR = "agent";
const PI_SESSIONS_DIR = "sessions";
const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export function registerPiConversationRoutes(router: Router, context: PiConversationContext): void {
  router.get("/api/pi/conversations", (request) => piConversationListResponse(context, request));
  router.post("/api/pi/conversations", async (request) => piConversationCreateResponse(context, request));
  router.get("/api/pi/conversations/:id", (request) => piConversationResponse(context, request));
}

function piConversationListResponse(context: PiConversationContext, request: Request): Response {
  const params = new URL(request.url).searchParams;
  return json(listPiConversations(context.database, {
    projectId: cleanString(params.get("project_id")),
    status: cleanString(params.get("status"))
  }));
}

async function piConversationCreateResponse(context: PiConversationContext, request: Request): Promise<Response> {
  const body = await parseObjectBody(request);
  return writeResponse(async () => createConversationWithRuntime(context, body), 201);
}

function piConversationResponse(context: PiConversationContext, request: Request): Response {
  const conversation = getPiConversation(context.database, pathPart(request, "conversations"));
  if (!conversation) throw new HttpError(404, "资源不存在");
  return json(conversation);
}

async function createConversationWithRuntime(
  context: PiConversationContext,
  body: Record<string, unknown>
): Promise<PiConversation> {
  const project = conversationProject(context.database, cleanString(body.project_id));
  const agent = conversationAgent(context.database, cleanString(body.pi_agent_id));
  const id = cleanString(body.id) || crypto.randomUUID();
  const runtime = await createOrRestorePiRuntime(context.database, { agent, conversationID: id, project });
  const conversation = createPiConversation(context.database, conversationInput({
    body,
    id,
    piAgentID: agent.id,
    projectID: project.id,
    runtime
  }));
  persistPiSessionIndex(context.database, conversation, project);
  return conversation;
}

async function createOrRestorePiRuntime(
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

async function createPiRuntimeSession(db: RunnerDatabase, input: RuntimeSessionInput) {
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
    tools: [...PI_READ_ONLY_TOOLS]
  });
  if (input.agent.name !== "") session.setSessionName(input.agent.name);
  return { session };
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

async function ensurePiSessionFile(session: {
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

function conversationInput(input: {
  body: Record<string, unknown>;
  id: string;
  piAgentID: string;
  projectID: string;
  runtime: PiRuntimeResult;
}): Record<string, unknown> {
  return {
    id: input.id,
    pi_agent_id: input.piAgentID,
    pi_session_id: input.runtime.piSessionId,
    project_id: input.projectID,
    session_file: input.runtime.sessionFile,
    status: cleanString(input.body.status) || "active",
    title: cleanString(input.body.title)
  };
}

function persistPiSessionIndex(
  db: RunnerDatabase,
  conversation: PiConversation,
  project: Project
): void {
  upsertAgentSession(db, {
    provider: PI_SESSION_PROVIDER,
    provider_session_id: conversation.pi_session_id,
    agent_role: PI_SESSION_ROLE,
    project_id: project.id,
    title: conversation.title,
    preview: "",
    status: conversation.status,
    raw_ref: { conversation_id: conversation.id, session_file: conversation.session_file }
  });
}

function conversationProject(db: RunnerDatabase, id: string): Project {
  if (id === "") throw new HttpError(400, "project_id is required");
  const project = getProject(db, id);
  if (!project) throw new HttpError(404, "资源不存在");
  return project;
}

function conversationAgent(db: RunnerDatabase, id: string): PiAgent {
  const agentID = id || (listPiAgents(db).find((agent) => agent.enabled === 1)?.id ?? "");
  if (agentID === "") throw new HttpError(400, "PI agent 不存在");
  const agent = getPiAgent(db, agentID);
  if (!agent) throw new HttpError(400, "PI agent 不存在");
  if (agent.enabled !== 1) throw new HttpError(400, "disabled PI agent cannot start conversation");
  return agent;
}

function resolvePiModel(modelRegistry: { find(provider: string, modelID: string): Model<any> | undefined }, agent: PiAgent) {
  if (agent.model_provider === "" || agent.model_id === "") return undefined;
  return modelRegistry.find(agent.model_provider, agent.model_id);
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  return isThinkingLevel(value) ? value : "medium";
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
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

function pathPart(request: Request, marker: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf(marker) + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, `${marker} id 不能为空`);
  return decodeURIComponent(value);
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
