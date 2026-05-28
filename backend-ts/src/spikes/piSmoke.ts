import {
  AuthStorage,
  SessionManager,
  SettingsManager,
  VERSION as piSdkVersion
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type SmokeOptions = {
  cwd: string;
  stateDir: string;
  tempDir?: string;
  createDirs: boolean;
};

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const DEFAULT_STATE_DIR = join(REPO_ROOT, "data-bun");
const HELP_FLAGS = new Set(["--help", "-h"]);

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
    createDirs: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (HELP_FLAGS.has(arg)) return "help";
    if (arg === "--no-create") {
      options.createDirs = false;
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
    createDirs: options.createDirs
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

function printHelp(): void {
  console.log(`Usage: bun run src/spikes/piSmoke.ts [options]

Options:
  --cwd <path>        Project cwd for PI session defaults (default: repo root)
  --state-dir <path>  Bun backend state dir (default: ../data-bun)
  --temp-dir <path>   PI smoke runtime dir (default: <stateDir>/tmp/pi-smoke)
  --no-create         Do not create smoke directories
  --help, -h          Show this help

The smoke harness only imports PI SDK pieces and prints a redacted config summary.
It does not start an HTTP server or create an agent session turn.`);
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

  const authStorage = AuthStorage.create(config.authPath);
  const settingsManager = SettingsManager.inMemory({ sessionDir: config.sessionDir });
  const sessionManager = SessionManager.create(config.cwd, config.sessionDir);

  const summary = {
    ok: true,
    piSdkVersion,
    cwd: summarizePath(config.cwd, config.stateDir),
    stateDir: summarizePath(config.stateDir, config.stateDir),
    piAgentDir: summarizePath(config.piAgentDir, config.stateDir),
    authPath: summarizePath(config.authPath, config.stateDir),
    settingsPath: summarizePath(config.settingsPath, config.stateDir),
    sessionDir: summarizePath(config.sessionDir, config.stateDir),
    createDirs: config.createDirs,
    typebox: ConfigSchema.type,
    sdkImports: {
      authStorage: authStorage.constructor.name,
      settingsManager: settingsManager.constructor.name,
      sessionManager: sessionManager.constructor.name
    },
    note: "paths are redacted relative to <stateDir>; no HTTP server started"
  };

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exitCode = 1;
});
