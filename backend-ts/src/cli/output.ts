import type { SystemStatusDTO } from "./types.ts";

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

export function formatJSON(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
