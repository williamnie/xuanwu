import { redactSensitiveText } from "../util/redact.ts";
import type { ProjectDTO, SystemLogLineDTO, SystemLogsDTO, SystemStatusDTO } from "./types.ts";

export function formatProject(project: ProjectDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(project);
  return `${project.id} [${project.loop_status ?? "stopped"}] ${project.cwd}\n`;
}

export function formatSystemStatus(status: SystemStatusDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(status);
  const alive = status.service?.alive ?? false;
  const dbOK = status.db?.ok ?? false;
  const codexOK = status.codex?.command_ok ?? false;
  const auth = status.config?.auth_enabled ?? status.auth?.enabled ?? false;
  const loops = status.runner?.running_loops ?? 0;
  const inProgress = status.runner?.in_progress_issues ?? 0;
  return `API alive=${alive} db=${dbOK} codex_cmd=${codexOK} auth=${auth} loops=${loops} in_progress=${inProgress}\n`;
}

export function formatSystemLogs(summary: SystemLogsDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(summary);
  const lines = (summary.logs ?? []).flatMap((log) => {
    if (!log.available) return [`${log.source} unavailable: ${log.error ?? "not available"}\n`];
    return (log.lines ?? []).map(formatLogLine);
  });
  return lines.length > 0 ? lines.join("") : "no runtime logs available\n";
}

export function formatJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function formatLogLine(line: SystemLogLineDTO): string {
  const prefix = [line.time, line.level, line.source].filter(Boolean).join(" ");
  return `${prefix}: ${redactSensitiveText(line.text ?? "")}\n`;
}
