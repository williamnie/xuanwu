import { piCredentialPaths } from "../../pi/runtime/piModelRuntime.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getModel, getProviders, type KnownProvider, type Model } from "@earendil-works/pi-ai/compat";
import { dirname, join, resolve } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import type { PiAgent } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import { PI_SAFE_ACTION_TYPES } from "../../pi/actions/actionGate.ts";
import { type SmokeRuntime } from "../../spikes/piSmokeSupport.ts";
import { SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES } from "../../pi/supervisor/supervisorControlContracts.ts";
import type { RuntimeSessionInput, RuntimeCleanup, PiModelRegistry } from "./piRuntime.model.ts";

export const PI_RUNNER_CHAT_ACTIONS = [
  "skill.install", "skill.enable", "skill.disable", "skill.update", "skill.rollback", "skill.uninstall",
  ...PI_SAFE_ACTION_TYPES,
  "agent.executor_assign",
  "agent.workflow_request",
  "human_review.respond",
  "issue.create",
  "issue.cancel",
  "issue.delete",
  "issue.acceptance_request",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.status_update",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel",
  "notification.preference.update",
  "project.create",
  "runner.settings_update",
  "system.restart",
  "workspace.make_directory",
  "workspace.write_file",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES
] as const;

export const PI_RUNTIME_ROOT = "pi-runtime";

export const RUNNER_RUNTIME_ROOT = ".runner";

export const RUNNER_SESSIONS_DIR = "sessions";

export const RUNNER_AGENT_DIR = "runner";

export const PI_SMOKE_FAUX_PROVIDER = "pi-smoke-faux";

export const PI_SMOKE_FAUX_API = "pi-smoke-faux-api";

export const PI_SMOKE_FAUX_MODEL = "faux-1";

export const PI_SMOKE_FAUX_RESPONSE = "pi-smoke-response-ok";

export function defaultIssueQueryScope(input: RuntimeSessionInput): "global" | "project" {
  if (input.promptProfile !== "chat" || input.chatToolMode === "review") return "project";
  const binding = input.supervisorContext?.provenance.target_binding;
  return binding === "explicit" || binding === "one_shot" ? "project" : "global";
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

export function positiveContextWindow(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export const piRuntimePaths = piCredentialPaths;

export function runtimeContext(db: RunnerDatabase, project: Project | undefined) {
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

export function ensureRuntimeProvider(
  sdk: SmokeRuntime,
  _modelRuntime: InstanceType<SmokeRuntime["pi"]["ModelRuntime"]>,
  agent: PiAgent
): RuntimeCleanup {
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

export function isLocalSmokeFauxAgent(agent: PiAgent): boolean {
  return agent.model_provider === PI_SMOKE_FAUX_PROVIDER && agent.model_id === PI_SMOKE_FAUX_MODEL;
}

export function noopRuntimeCleanup(): void {}

export function resolvePiModel(modelRegistry: PiModelRegistry, agent: PiAgent) {
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

export function isCustomOpenAIGptModel(model: Model<any>, agent: PiAgent): boolean {
  return ["openai", "openai-codex"].includes(agent.model_provider) &&
    ["openai-responses", "openai-codex-responses"].includes(model.api) &&
    /^gpt(?:[-_.]|$)/i.test(agent.model_id);
}

export function knownModelProvider(provider: string): KnownProvider | undefined {
  return (getProviders() as string[]).includes(provider) ? provider as KnownProvider : undefined;
}

export function isDefaultCustomModelMetadata(model: Model<any>): boolean {
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

export function normalizeThinkingLevel(value: string): ThinkingLevel {
  return isThinkingLevel(value) ? value : "medium";
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}
