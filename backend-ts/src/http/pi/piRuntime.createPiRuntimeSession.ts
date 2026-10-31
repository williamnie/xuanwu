import { createPiModelRuntime, selectedCredentialSource } from "../../pi/runtime/piModelRuntime.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../../spikes/piSmokeSupport.ts";
import { installPiSdkToolAudit } from "./piSdkToolAudit.ts";
import { installPiContextBudgetObservation } from "./piContextBudgetObservation.ts";
import { createPiRuntimeResourceLoader } from "./piRuntimeResources.ts";
import { buildPiRuntimeSystemPrompt } from "./piRuntimePrompt.ts";
import { createPiRuntimeToolKit, recordPiRuntimeToolRegistryAudit, unavailablePiRuntimeToolRegistryAudit } from "../../pi/tools/piRuntimeTools.ts";
import { installPiProviderSecretOverride } from "../../security/secrets/piProviderRuntime.ts";
import { buildPiRuntimeContextEnvelope, recordPiRuntimeContextEnvelopeAudit } from "../../pi/runtime/runtimeContextEnvelope.ts";
import { errorMessage } from "../../util/values.ts";
import type { RuntimeSessionInput, PiRuntimeResult, RuntimeCleanup } from "./piRuntime.model.ts";
import { runtimeContext, piRuntimePaths, ensureRuntimeProvider, resolvePiModel, piRuntimeCompactionSettings, defaultIssueQueryScope, normalizeThinkingLevel, noopRuntimeCleanup } from "./piRuntime.piRuntimeModelMetadata.ts";

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

  const modelRuntime = await createPiModelRuntime(sdk.pi, {
    database: db,
    authPath: paths.authPath,
    modelsPath: paths.modelsPath,
    refreshOnCreate: false
  });
  const cleanupRuntimeProvider = ensureRuntimeProvider(sdk, modelRuntime, input.agent);
  if (selectedCredentialSource(db) !== "codex_login" || input.agent.model_provider !== "openai-codex") {
    await installPiProviderSecretOverride(modelRuntime, paths.modelsPath, dirname(db.path), input.agent.model_provider);
  }
  const settingsManager = sdk.pi.SettingsManager.create(context.cwd, paths.agentDir);
  const model = resolvePiModel({ find: (provider, modelID) => modelRuntime.getModel(provider, modelID) }, input.agent);
  const compactionSettings = piRuntimeCompactionSettings(model);
  settingsManager.applyOverrides({
    compaction: input.promptProfile === "memory_reflection" ? { ...compactionSettings, enabled: false } : compactionSettings,
    ...(input.retry ? { retry: input.retry } : {})
  });
  const sessionManager = input.sessionFile
    ? sdk.pi.SessionManager.open(input.sessionFile, context.sessionDir, context.cwd)
    : sdk.pi.SessionManager.create(context.cwd, context.sessionDir, { id: input.conversationID });
  const toolContext = {
    auditSystemRestart: input.auditSystemRestart,
    authorization: input.authorization,
    bus: input.bus,
    cliConnectorDirs: input.cliConnectorDirs,
    codeAgentCatalog: input.codeAgentCatalog,
    conversationID: input.conversationID,
    config: input.config,
    delegationID: input.delegationID,
    env: input.env,
    heartbeatID: input.heartbeatID,
    issueID: input.issueID,
    issueQueryDefaultScope: defaultIssueQueryScope(input),
    notificationTarget: input.notificationTarget,
    onIssueEnqueued: input.onIssueEnqueued,
    providers: input.providers,
    restartDelayMs: input.restartDelayMs,
    restartProcess: input.restartProcess,
    source: input.source,
    sourceTurn: input.sourceTurn,
    supervisorManaged: input.supervisorManaged
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
    runtimeTools = createPiRuntimeToolKit(db, toolProject, toolContext, {
      chatToolMode: input.chatToolMode,
      promptProfile: input.promptProfile,
      memoryReflection: input.memoryReflection
    });
    recordPiRuntimeToolRegistryAudit(db, toolAuditInput, runtimeTools.audit);
  } catch (error) {
    recordPiRuntimeToolRegistryAudit(db, toolAuditInput, unavailablePiRuntimeToolRegistryAudit(error));
    cleanupRuntimeProvider();
    throw new Error(`PI runtime tool registry unavailable: ${errorMessage(error)}`, { cause: error });
  }
  try {
    const systemPrompt = buildPiRuntimeSystemPrompt(input, db);
    const runtimeContextEnvelope = buildPiRuntimeContextEnvelope(db, input);
    recordPiRuntimeContextEnvelopeAudit(db, input, runtimeContextEnvelope, systemPrompt);
    const resourceLoader = await createPiRuntimeResourceLoader(sdk, db, input, {
      agentDir: paths.agentDir,
      cwd: context.cwd,
      piPackageDir: process.env.PI_PACKAGE_DIR,
      runtimeRoot,
      systemPrompt
    });
    const { session } = await sdk.pi.createAgentSession({
      cwd: context.cwd,
      agentDir: paths.agentDir,
      model,
      modelRuntime,
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
      source: input.source,
      toolAuditTargets: runtimeTools.auditTargets
    });
    const cleanupContextBudgetObservation = installPiContextBudgetObservation(db, {
      ...input,
      projectID: toolProject?.id ?? input.project?.id
    }, {
      baseSystemPrompt: systemPrompt,
      compactionReserveTokens: compactionSettings.reserveTokens,
      resourceSnapshot: resourceLoader.snapshot(),
      runtimeContextEnvelope,
      session
    });
    if (input.agent.name !== "") session.setSessionName(input.agent.name);
    return {
      session,
      dispose: () => disposePiRuntimeSession(session, cleanupRuntimeProvider, () => {
        cleanupContextBudgetObservation();
        cleanupSdkAudit();
      })
    };
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

export function disposePiRuntimeSession(
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

export function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
