import { join } from "node:path";
import type { RunnerConfig } from "../config/env.ts";
import { redactSensitiveText } from "../util/redact.ts";

const DEFAULT_LINE_LIMIT = 120;
const MAX_LINE_LIMIT = 500;

type RuntimeLogLine = { level: string; path: string; source: string; text: string; time: string };

type RuntimeLogFile = {
  available: boolean;
  error?: string;
  lines?: RuntimeLogLine[];
  path: string;
  source: string;
};

export type RuntimeLogsSummary = {
  generated_at: string;
  line_limit: number;
  logs: RuntimeLogFile[];
  recent_errors: RuntimeLogLine[];
  recent_warnings: RuntimeLogLine[];
};

export async function buildRuntimeLogs(config: RunnerConfig, lines: number): Promise<RuntimeLogsSummary> {
  const lineLimit = sanitizeLineLimit(lines);
  const logs = await Promise.all(runtimeLogPaths(config).map((logPath) => readRuntimeLog(logPath, lineLimit)));
  return {
    generated_at: new Date().toISOString(),
    line_limit: lineLimit,
    logs,
    recent_errors: filterLogLines(logs, "error"),
    recent_warnings: filterLogLines(logs, "warning")
  };
}

export function runtimeLogLineLimit(request: Request): number {
  return sanitizeLineLimit(Number(new URL(request.url).searchParams.get("lines")));
}

function sanitizeLineLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) return DEFAULT_LINE_LIMIT;
  return Math.min(value, MAX_LINE_LIMIT);
}

function runtimeLogPaths(config: RunnerConfig): Array<{ path: string; source: string }> {
  const base = join(config.stateDir, "logs");
  return [
    { source: "server", path: join(base, "launchd.out.log") },
    { source: "runner", path: join(base, "launchd.err.log") }
  ];
}

async function readRuntimeLog(logPath: { path: string; source: string }, limit: number): Promise<RuntimeLogFile> {
  try {
    const content = await Bun.file(logPath.path).text();
    return {
      source: logPath.source,
      path: logPath.path,
      available: true,
      lines: normalizeRuntimeLogLines(logPath, tailLines(content, limit))
    };
  } catch (error) {
    return {
      source: logPath.source,
      path: logPath.path,
      available: false,
      error: runtimeLogError(error)
    };
  }
}

function tailLines(content: string, limit: number): string[] {
  if (limit <= 0) return [];
  return content.split(/\r?\n/).filter((line) => line !== "").slice(-limit);
}

function normalizeRuntimeLogLines(logPath: { path: string; source: string }, lines: string[]): RuntimeLogLine[] {
  return lines.map((line) => {
    const text = redactSensitiveText(line);
    return {
      source: logPath.source,
      path: logPath.path,
      time: detectLogTime(text),
      level: detectLogLevel(text),
      text
    };
  });
}

function detectLogTime(line: string): string {
  const fields = line.trim().split(/\s+/);
  const first = fields[0]?.replace(/^\[|\]$/g, "") ?? "";
  if (!Number.isNaN(Date.parse(first))) return first;
  const twoFields = `${fields[0] ?? ""} ${fields[1] ?? ""}`.replace(/^\[|\]$/g, "");
  return /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/.test(twoFields) ? twoFields : "";
}

function detectLogLevel(line: string): string {
  const lower = line.toLowerCase();
  if (lower.includes("panic") || lower.includes("fatal") || lower.includes("error") || lower.includes("failed")) {
    return "error";
  }
  return lower.includes("warn") ? "warning" : "info";
}

function filterLogLines(logs: RuntimeLogFile[], level: string): RuntimeLogLine[] {
  return logs.flatMap((log) => log.lines ?? []).filter((line) => line.level === level);
}

function runtimeLogError(error: unknown): string {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return "log file does not exist";
  }
  if (error instanceof Error && "code" in error && error.code === "EACCES") {
    return "permission denied reading log file";
  }
  return error instanceof Error ? error.message : "failed reading log file";
}
