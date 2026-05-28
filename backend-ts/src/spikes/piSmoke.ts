import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  type AgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  VERSION as piSdkVersion
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  READ_ONLY_TOOLS,
  buildEventsSummary,
  buildReadOnlyToolCallResponse,
  buildToolBoundarySummary,
  runPrompt,
  type PromptResult
} from "./piSmokeSupport.ts";

type SmokeOptions = {
  cwd: string;
  stateDir: string;
  tempDir?: string;
  createDirs: boolean;
  events: boolean;
  toolsReadonly: boolean;
};

type SmokeConfig = ReturnType<typeof buildConfig>;
type SmokeSdk = ReturnType<typeof createSmokeSdk>;

type BuildSummaryArgs = {
  config: SmokeConfig;
  sdk: SmokeSdk;
  session: AgentSession;
  prompt: PromptResult;
};

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_STATE_DIR = join(REPO_ROOT, "data-bun");
const HELP_FLAGS = new Set(["--help", "-h"]);
const RESPONSE_PREVIEW_MAX = 120;
const RESPONSE_PREVIEW_SUFFIX = "...";
const SMOKE_API = "pi-smoke-faux-api";
const SMOKE_PROVIDER = "pi-smoke-faux";
const SMOKE_RESPONSE = "pi-smoke-response-ok";
const SMOKE_RUNTIME_KEY_LABEL = "<redacted-local-smoke-key>";
const SMOKE_TOKENS_PER_SECOND = 0;

const ConfigSchema = Type.Object({
  cwd: Type.String(),
  stateDir: Type.String(),
  piAgentDir: Type.String(),
  authPath: Type.String(),
  settingsPath: Type.String(),
  sessionDir: Type.String(),
  createDirs: Type.Boolean()
});

function parseArgs(argv: string[]): SmokeOptions | "help" {
  const options: SmokeOptions = {
    cwd: REPO_ROOT,
    stateDir: DEFAULT_STATE_DIR,
    createDirs: true,
    events: false,
    toolsReadonly: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (HELP_FLAGS.has(arg)) return "help";
    if (arg === "--no-create") {
      options.createDirs = false;
      continue;
    }
    if (arg === "--events") {
      options.events = true;
      continue;
    }
    if (arg === "--tools-readonly") {
      options.toolsReadonly = true;
      continue;
    }

    const value = readOptionValue(argv, index);
    if (value === undefined) throw new Error(`Missing value for ${arg}`);

    if (arg === "--cwd") options.cwd = value;
    else if (arg === "--state-dir") options.stateDir = value;
    else if (arg === "--temp-dir") options.tempDir = value;
    else throw new Error("Unknown argument");

    index += 1;
  }

  return options;
}

function readOptionValue(argv: string[], index: number): string | undefined {
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) return undefined;
  return next;
}

function buildConfig(options: SmokeOptions) {
  const cwd = resolve(options.cwd);
  const stateDir = resolve(options.stateDir);
  const runtimeRoot = resolve(options.tempDir ?? join(stateDir, "tmp", "pi-smoke"));
  const piAgentDir = join(runtimeRoot, "agent");
  const sessionDir = join(runtimeRoot, "sessions");

  return {
    cwd,
    stateDir,
    piAgentDir,
    authPath: join(piAgentDir, "auth.json"),
    settingsPath: join(piAgentDir, "settings.json"),
    sessionDir,
    createDirs: options.createDirs,
    events: options.events,
    toolsReadonly: options.toolsReadonly
  };
}

function ensureUnderStateDir(label: string, path: string, stateDir: string): void {
  const rel = relative(stateDir, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new Error(`${label} must be under stateDir`);
}

function ensureRuntimeDirs(config: ReturnType<typeof buildConfig>): void {
  const paths = [
    config.piAgentDir,
    dirname(config.authPath),
    dirname(config.settingsPath),
    config.sessionDir
  ];
  for (const path of paths) mkdirSync(path, { recursive: true });
}

function summarizePath(path: string, stateDir: string): string {
  const rel = relative(stateDir, path);
  if (rel === "") return "<stateDir>";
  if (!rel.startsWith("..") && !isAbsolute(rel)) return `<stateDir>/${rel}`;
  return "<outside-stateDir>";
}

function createSmokeResourceLoader(): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "You are a minimal PI smoke test assistant. Reply concisely.",
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {}
  };
}

function summarizeText(text: string): string {
  const contentLength = RESPONSE_PREVIEW_MAX - RESPONSE_PREVIEW_SUFFIX.length;
  return text.length > RESPONSE_PREVIEW_MAX
    ? `${text.slice(0, contentLength)}${RESPONSE_PREVIEW_SUFFIX}`
    : text;
}

function createSmokeSdk(config: SmokeConfig) {
  const authStorage = AuthStorage.create(config.authPath);
  const settingsManager = SettingsManager.inMemory({ sessionDir: config.sessionDir });
  const sessionManager = SessionManager.create(config.cwd, config.sessionDir);
  authStorage.setFallbackResolver((provider) => {
    return provider === SMOKE_PROVIDER ? SMOKE_RUNTIME_KEY_LABEL : undefined;
  });

  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const fauxProvider = registerFauxProvider({
    api: SMOKE_API,
    provider: SMOKE_PROVIDER,
    tokensPerSecond: SMOKE_TOKENS_PER_SECOND
  });
  fauxProvider.setResponses(config.toolsReadonly
    ? [buildReadOnlyToolCallResponse(), fauxAssistantMessage(SMOKE_RESPONSE)]
    : [fauxAssistantMessage(SMOKE_RESPONSE)]);

  return { authStorage, settingsManager, sessionManager, modelRegistry, fauxProvider };
}

async function createSmokeSession(config: SmokeConfig, sdk: SmokeSdk): Promise<AgentSession> {
  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.piAgentDir,
    authStorage: sdk.authStorage,
    modelRegistry: sdk.modelRegistry,
    model: sdk.fauxProvider.getModel(),
    thinkingLevel: "off",
    resourceLoader: createSmokeResourceLoader(),
    tools: config.toolsReadonly ? [...READ_ONLY_TOOLS] : [],
    sessionManager: sdk.sessionManager,
    settingsManager: sdk.settingsManager
  });
  return session;
}

function buildSummary({ config, sdk, session, prompt }: BuildSummaryArgs) {
  const toolBoundary = buildToolBoundarySummary(config, session, prompt.toolProbes);
  const events = buildEventsSummary(config, prompt.events);
  const ok = prompt.responseText.length > 0 && toolBoundary.ok && events.ok;

  return {
    ok,
    piSdkVersion,
    cwd: summarizePath(config.cwd, config.stateDir),
    stateDir: summarizePath(config.stateDir, config.stateDir),
    piAgentDir: summarizePath(config.piAgentDir, config.stateDir),
    authPath: summarizePath(config.authPath, config.stateDir),
    settingsPath: summarizePath(config.settingsPath, config.stateDir),
    sessionDir: summarizePath(config.sessionDir, config.stateDir),
    createDirs: config.createDirs,
    typebox: ConfigSchema.type,
    sdkObjects: {
      authStorage: sdk.authStorage.constructor.name,
      settingsManager: sdk.settingsManager.constructor.name,
      sessionManager: sdk.sessionManager.constructor.name
    },
    session: {
      id: session.sessionManager.getSessionId(),
      persisted: session.sessionManager.isPersisted(),
      messageCount: session.state.messages.length,
      model: `${session.model?.provider}/${session.model?.id}`
    },
    prompt: {
      completed: prompt.responseText.length > 0,
      responsePreview: summarizeText(prompt.responseText),
      providerCalls: sdk.fauxProvider.state.callCount
    },
    events,
    toolBoundary,
    note: "paths are redacted relative to <stateDir>; faux provider uses no token/secrets"
  };
}

function printHelp(): void {
  console.log(`Usage: bun run src/spikes/piSmoke.ts [options]

Options:
  --cwd <path>        Project cwd for PI session defaults (default: repo root)
  --state-dir <path>  Bun backend state dir (default: ../data-bun)
  --temp-dir <path>   PI smoke runtime dir (default: <stateDir>/tmp/pi-smoke)
  --no-create         Do not create smoke directories
  --events            Record key PI session event order
  --tools-readonly    Enable read/grep/find/ls and probe disabled edit/write/bash
  --help, -h          Show this help

The smoke harness creates a PI AgentSession with a local faux provider, runs one
short prompt, and prints only a redacted response summary. Use --events and
--tools-readonly to verify PI event streaming and read-only tool boundaries.`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(Bun.argv.slice(2));
  if (parsed === "help") {
    printHelp();
    return;
  }

  const config = buildConfig(parsed);
  ensureUnderStateDir("piAgentDir", config.piAgentDir, config.stateDir);
  ensureUnderStateDir("authPath", config.authPath, config.stateDir);
  ensureUnderStateDir("settingsPath", config.settingsPath, config.stateDir);
  ensureUnderStateDir("sessionDir", config.sessionDir, config.stateDir);

  if (config.createDirs) ensureRuntimeDirs(config);

  const sdk = createSmokeSdk(config);
  const session = await createSmokeSession(config, sdk);

  try {
    const prompt = await runPrompt(session, config);
    const summary = buildSummary({ config, sdk, session, prompt });
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    session.dispose();
    sdk.fauxProvider.unregister();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exitCode = 1;
});
