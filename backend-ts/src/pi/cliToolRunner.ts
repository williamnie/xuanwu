import { spawn } from "node:child_process";
import type {
  CliCommandTemplate,
  CliConnectorCommand,
  CliConnectorHealth,
  CliExitCodeContract
} from "./cliConnectorManifest.ts";
import {
  buildAllowedEnv,
  createCollector,
  publicCapture,
  safeMessage,
  sanitizeText,
  sanitizeValue,
  SECRET_ENV_RE,
  stderrCapture,
  type CapturedText,
  type StderrMode
} from "./cliToolRunnerSupport.ts";
import type { ToolResult } from "./toolProviderEnvelope.ts";

export const CLI_TOOL_ERROR_CODES = {
  invalidJson: "cli_invalid_json",
  nonZeroExit: "cli_exit_nonzero",
  spawnError: "cli_spawn_error",
  stdoutTooLarge: "cli_stdout_too_large",
  templateError: "cli_template_error",
  timeout: "cli_timeout",
  unsupportedStdout: "cli_unsupported_stdout"
} as const;

export type CliToolRunRequest = {
  command: CliConnectorCommand | CliConnectorHealth;
  input?: Record<string, unknown>;
  invocationID: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  envAllowlist?: string[];
  secretEnvNames?: string[];
  redactInputFields?: string[];
  timeoutMs?: number;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
};

type RenderedCommand = { executable: string; args: string[] };
type SpawnOutcome = {
  error?: Error;
  exitCode: number | null;
  signal: string | null;
  stderr: CapturedText;
  stdout: CapturedText;
  timedOut: boolean;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STDOUT_MAX_BYTES = 64 * 1024;
const DEFAULT_STDERR_MAX_BYTES = 8 * 1024;
const TEMPLATE_RE = /{{\s*input\.([A-Za-z0-9_]+)\s*}}/g;
const UNSAFE_EXECUTABLE_RE = /[\s|&;<>()$`]/;

export async function runCliTool(request: CliToolRunRequest): Promise<ToolResult> {
  const startedAt = new Date();
  const started = performance.now();
  const env = buildAllowedEnv(request.env ?? process.env, request.envAllowlist);
  const secrets = secretValues(request, env);

  try {
    if (request.command.stdout.mode !== "json") {
      return result(request, startedAt, started, "failed", undefined, error(CLI_TOOL_ERROR_CODES.unsupportedStdout, "CLI stdout mode must be json"));
    }
    const rendered = renderCliCommand(request.command.command, request.input ?? {});
    const timeoutMs = request.timeoutMs ?? request.command.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const outcome = await spawnCommand(rendered, {
      cwd: request.cwd,
      env,
      stderrLimit: stderrLimit(request),
      stderrMode: request.command.stderr?.summary ?? "tail",
      stdoutLimit: request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
      timeoutMs
    });
    return resultFromOutcome(request, rendered, outcome, secrets, startedAt, started, timeoutMs, Object.keys(env).sort());
  } catch (caught) {
    return result(request, startedAt, started, "failed", undefined, error(CLI_TOOL_ERROR_CODES.templateError, safeMessage(caught, secrets)));
  }
}

export function renderCliCommand(command: CliCommandTemplate, input: Record<string, unknown>): RenderedCommand {
  if (!safeExecutable(command.executable)) throw new Error("command.executable is not a safe executable path");
  return {
    executable: command.executable,
    args: (command.args ?? []).map((arg) => renderArg(arg, input))
  };
}

function resultFromOutcome(
  request: CliToolRunRequest,
  rendered: RenderedCommand,
  outcome: SpawnOutcome,
  secrets: string[],
  startedAt: Date,
  started: number,
  timeoutMs: number,
  envNames: string[]
): ToolResult {
  const metadata = cliMetadata(request, rendered, outcome, secrets, timeoutMs, envNames);
  if (outcome.timedOut) {
    return result(request, startedAt, started, "timeout", metadata, error(CLI_TOOL_ERROR_CODES.timeout, "CLI command timed out", metadata.cli));
  }
  if (outcome.error) {
    return result(request, startedAt, started, "failed", metadata, error(CLI_TOOL_ERROR_CODES.spawnError, safeMessage(outcome.error, secrets), metadata.cli));
  }
  if (!isSuccessExit(outcome.exitCode, request.command.exit_codes)) {
    return result(request, startedAt, started, "failed", metadata, error(CLI_TOOL_ERROR_CODES.nonZeroExit, "CLI command exited with a non-zero status", {
      ...metadata.cli,
      exit_category: exitCategory(outcome.exitCode, request.command.exit_codes)
    }));
  }
  if (outcome.stdout.truncated) {
    return result(request, startedAt, started, "failed", metadata, error(CLI_TOOL_ERROR_CODES.stdoutTooLarge, "CLI stdout exceeded the configured capture limit", metadata.cli));
  }
  return parseJsonResult(request, outcome.stdout.raw, metadata, secrets, startedAt, started);
}

function parseJsonResult(
  request: CliToolRunRequest,
  stdout: string,
  metadata: Record<string, unknown>,
  secrets: string[],
  startedAt: Date,
  started: number
): ToolResult {
  try {
    return result(request, startedAt, started, "succeeded", metadata, undefined, sanitizeValue(JSON.parse(stdout), secrets));
  } catch (caught) {
    return result(request, startedAt, started, "failed", metadata, error(CLI_TOOL_ERROR_CODES.invalidJson, "CLI stdout was not valid JSON", {
      parse_error: safeMessage(caught, secrets),
      ...(metadata as { cli?: unknown })
    }));
  }
}

function result(
  request: CliToolRunRequest,
  startedAt: Date,
  started: number,
  status: ToolResult["status"],
  metadata?: Record<string, unknown>,
  resultError?: ToolResult["error"],
  output?: unknown
): ToolResult {
  const endedAt = new Date();
  return {
    invocation_id: request.invocationID,
    status,
    ...(output === undefined ? {} : { output }),
    ...(resultError === undefined ? {} : { error: resultError }),
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
    ...(metadata === undefined ? {} : { metadata })
  };
}

async function spawnCommand(
  command: RenderedCommand,
  options: { cwd?: string; env: Record<string, string>; stderrLimit: number; stderrMode: StderrMode; stdoutLimit: number; timeoutMs: number }
): Promise<SpawnOutcome> {
  return await new Promise((resolve) => {
    const stdout = createCollector(options.stdoutLimit, "head");
    const stderr = createCollector(options.stderrLimit, stderrCapture(options.stderrMode));
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command.executable, command.args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 250);
      killTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (childError) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ error: childError, exitCode: null, signal: null, stderr: stderr.finish(options.stderrMode), stdout: stdout.finish(), timedOut });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: code, signal, stderr: stderr.finish(options.stderrMode), stdout: stdout.finish(), timedOut });
    });
  });
}

function cliMetadata(
  request: CliToolRunRequest,
  rendered: RenderedCommand,
  outcome: SpawnOutcome,
  secrets: string[],
  timeoutMs: number,
  envNames: string[]
): Record<string, unknown> {
  return {
    cli: {
      args: rendered.args.map((arg) => sanitizeText(arg, secrets)),
      cwd: request.cwd,
      env_names: envNames,
      executable: sanitizeText(rendered.executable, secrets),
      exit_code: outcome.exitCode,
      signal: outcome.signal,
      stderr: publicCapture(outcome.stderr, secrets),
      stdout: publicCapture(outcome.stdout, secrets),
      timed_out: outcome.timedOut,
      timeout_ms: timeoutMs
    }
  };
}

function stderrLimit(request: CliToolRunRequest): number {
  return request.stderrMaxBytes ?? request.command.stderr?.max_bytes ?? DEFAULT_STDERR_MAX_BYTES;
}

function renderArg(template: string, input: Record<string, unknown>): string {
  const rendered = template.replace(TEMPLATE_RE, (_match, field: string) => cliArg(input[field]));
  if (rendered.includes("{{") || rendered.includes("}}")) throw new Error("command args may only use {{input.field}} templates");
  return rendered;
}
function cliArg(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function safeExecutable(value: string): boolean {
  return value.trim() !== "" && !UNSAFE_EXECUTABLE_RE.test(value);
}

function secretValues(request: CliToolRunRequest, env: Record<string, string>): string[] {
  const names = new Set([...(request.secretEnvNames ?? []), ...Object.keys(env).filter((name) => SECRET_ENV_RE.test(name))]);
  const values = [...names].flatMap((name) => env[name] ? [env[name]] : []);
  return [...values, ...secretInputValues(request)].filter((value) => value.length >= 3);
}

function secretInputValues(request: CliToolRunRequest): string[] {
  return (request.redactInputFields ?? []).flatMap((field) => {
    const value = request.input?.[field];
    return typeof value === "string" ? [value] : [];
  });
}

function isSuccessExit(code: number | null, contract: CliExitCodeContract): boolean {
  return code !== null && contract.success.includes(code);
}

function exitCategory(code: number | null, contract: CliExitCodeContract): string {
  if (code === null) return "unknown";
  if (contract.auth_required?.includes(code)) return "auth_required";
  if (contract.retryable?.includes(code)) return "retryable";
  if (contract.usage_error?.includes(code)) return "usage_error";
  return "nonzero";
}

function error(code: string, message: string, details?: unknown): ToolResult["error"] {
  return { code, message, ...(details === undefined ? {} : { details }) };
}
