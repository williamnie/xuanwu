import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export const CODEX_SERVER_MODES = ["cli", "app"] as const;
export type CodexServerMode = typeof CODEX_SERVER_MODES[number];

const DEFAULT_CLI_COMMAND = "codex app-server --listen stdio://";
const FALLBACK_APP_CODEX_PATH = "/Applications/Codex.app/Contents/Resources/codex";
const NATIVE_HOSTS_V2 = "chrome-native-hosts-v2.json";

export type CodexNativeHostEntry = {
  appVersion?: string;
  channel?: string;
  cliVersion?: string;
  nativeHostVersion?: string;
  paths?: {
    codexCliPath?: string;
    codexHome?: string;
    nodeModuleDirs?: string[];
    nodePath?: string;
    resourcesPath?: string;
  };
  presence?: { pid?: number; startedAt?: string; lastSeenAt?: string };
  updatedAt?: string;
};

export type CodexAppIntegrationStatus = {
  command: string;
  installed: boolean;
  native_host_configured: boolean;
  path: string;
  presence_alive: boolean;
  presence_pid: number;
  running: boolean;
  version: string;
  warning?: string;
};

export type CodexCommandStatus = {
  available: boolean;
  command: string;
  error?: string;
  path?: string;
  version?: string;
};

export function defaultCodexCliCommand(): string {
  return DEFAULT_CLI_COMMAND;
}

export function normalizeCodexServerMode(value: unknown): CodexServerMode {
  return value === "app" ? "app" : "cli";
}

export function defaultCodexAppCommand(): string {
  const path = latestNativeHostEntry()?.paths?.codexCliPath?.trim() || FALLBACK_APP_CODEX_PATH;
  return `${path} app-server --listen stdio://`;
}

export function defaultCodexAppEnv(command = defaultCodexAppCommand()): Record<string, string> {
  const entry = latestNativeHostEntry();
  const paths = entry?.paths ?? {};
  const codexPath = firstCommandPart(command) || paths.codexCliPath || FALLBACK_APP_CODEX_PATH;
  const resourcesPath = paths.resourcesPath || appResourcesPath(codexPath);
  return compactStringRecord({
    BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
    BROWSER_USE_CODEX_APP_BUILD_FLAVOR: entry?.channel || "prod",
    BROWSER_USE_CODEX_APP_VERSION: entry?.appVersion || entry?.cliVersion || "",
    CODEX_CLI_PATH: codexPath,
    CODEX_HOME: paths.codexHome || defaultCodexHome(),
    NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: "Control the in-app browser in conjunction with the Browser Plugin.",
    NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: "Control the Chrome browser in conjunction with the Chrome Plugin. Prefer this method of controlling Chrome over alternatives (such as Computer Use) unless the user explicitly mentions an alternative.",
    NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
    NODE_REPL_NODE_MODULE_DIRS: (paths.nodeModuleDirs ?? defaultNodeModuleDirs(resourcesPath)).join(delimiter),
    NODE_REPL_NODE_PATH: paths.nodePath || `${resourcesPath}/cua_node/bin/node`,
    NODE_REPL_TRUSTED_CODE_PATHS: defaultCodexHome()
  });
}

export function codexAppIntegrationStatus(command = defaultCodexAppCommand()): CodexAppIntegrationStatus {
  const entry = latestNativeHostEntry();
  const path = firstCommandPart(command) || firstCommandPart(defaultCodexAppCommand());
  const presencePid = Number(entry?.presence?.pid ?? 0);
  const presenceAlive = processAlive(presencePid);
  const installed = isExecutable(path);
  return {
    command,
    installed,
    native_host_configured: entry !== undefined,
    path,
    presence_alive: presenceAlive,
    presence_pid: presencePid,
    running: presenceAlive,
    version: entry?.appVersion || entry?.cliVersion || "",
    ...(installed ? {} : { warning: "Codex App bundled codex binary was not found" })
  };
}

export function codexCommandStatus(command: string): CodexCommandStatus {
  const binary = firstCommandPart(command);
  const path = executablePath(binary);
  if (path === "") return { available: false, command, error: `exec: \"${binary}\" not found in PATH` };
  const version = commandVersion(path);
  return { available: true, command, path, ...(version ? { version } : {}) };
}

export function latestNativeHostEntry(): CodexNativeHostEntry | undefined {
  const entries = readNativeHostsV2().entries ?? [];
  return entries.sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))[0];
}

function readNativeHostsV2(): { entries?: CodexNativeHostEntry[] } {
  const path = `${defaultCodexHome()}/${NATIVE_HOSTS_V2}`;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as { entries?: CodexNativeHostEntry[] };
  } catch {
    return {};
  }
}

function firstCommandPart(command: string): string {
  const match = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/)?.[0] ?? "";
  return unquote(match);
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function appResourcesPath(codexPath: string): string {
  if (codexPath.endsWith("/Contents/Resources/codex")) return codexPath.slice(0, -"/codex".length);
  return "/Applications/Codex.app/Contents/Resources";
}

function defaultNodeModuleDirs(resourcesPath: string): string[] {
  return [`${resourcesPath}/cua_node/lib/node_modules`];
}

function defaultCodexHome(): string {
  return Bun.env.CODEX_HOME?.trim() || `${Bun.env.HOME || ""}/.codex`;
}

function compactStringRecord(value: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => (item ?? "").trim() !== "")) as Record<string, string>;
}

function isExecutable(path: string): boolean {
  try {
    const stat = statSync(path);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function executablePath(command: string): string {
  if (command === "") return "";
  if (command.includes("/")) return isExecutable(command) ? command : "";
  return Bun.which(command) ?? findInPath(command, Bun.env.PATH ?? "");
}

function findInPath(command: string, pathEnv: string): string {
  for (const dir of pathEnv.split(delimiter)) {
    const candidate = join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

function commandVersion(path: string): string {
  try {
    const result = Bun.spawnSync([path, "--version"], { stderr: "pipe", stdout: "pipe" });
    if (result.exitCode !== 0) return "";
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return "";
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return existsSync(`/proc/${pid}`);
  }
}
