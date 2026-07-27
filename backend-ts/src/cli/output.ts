import { redactSensitiveText } from "../util/redact.ts";
import type { IssueDTO, IssueEventDTO, ProjectDTO, SystemDoctorDTO, SystemLogLineDTO, SystemLogsDTO, SystemStatusDTO } from "./types.ts";

export function formatIssue(issue: IssueDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(issue);
  return `#${issue.id} [${issue.status}] ${issue.project_id} - ${issue.title}\n`;
}

export function formatIssueEvents(events: IssueEventDTO[], asJSON: boolean): string {
  if (asJSON) return formatJSON(events);
  return events.map(formatIssueEvent).join("");
}

export function formatProject(project: ProjectDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(project);
  const status = project.pi_managed === 1 || project.auto_run === 1 ? "managed" : project.loop_status ?? "stopped";
  return `${project.id} [${status}] ${project.cwd}\n`;
}

export function formatSystemStatus(status: SystemStatusDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(status);
  const alive = status.service?.alive ?? false;
  const dbOK = status.db?.ok ?? false;
  const codexOK = status.codex?.command_ok ?? false;
  const auth = status.config?.auth_enabled ?? status.auth?.enabled ?? false;
  const loops = status.runner?.running_loops ?? 0;
  const inProgress = status.runner?.in_progress_issues ?? 0;
  const codexCaps = status.codex?.capability_summary?.trim();
  const connectorText = connectorSummary(status.connectors);
  const suffix = [
    codexCaps ? `codex_caps=${codexCaps}` : "",
    connectorText ? `connectors=${connectorText}` : ""
  ].filter(Boolean).join(" ");
  return `API alive=${alive} db=${dbOK} codex_cmd=${codexOK} auth=${auth} loops=${loops} in_progress=${inProgress}${suffix ? ` ${suffix}` : ""}\n`;
}

export function formatSystemDoctor(doctor: SystemDoctorDTO, asJSON: boolean): string {
  if (asJSON) return formatJSON(doctor);
  const providers = Array.isArray(doctor.providers) ? doctor.providers : [];
  const providerSummary = providers.length > 0
    ? providers.map(provider => `${provider.id || "unknown"}:${provider.available ? "available" : provider.status || "missing"}`).join(",")
    : "none";
  const health = doctor.health?.state || (doctor.service?.alive && doctor.db?.ok ? "healthy" : "unknown");
  const lines = [
    `Doctor health=${health} api=${doctor.service?.alive ?? false} db=${doctor.db?.ok ?? false} providers=${providerSummary}\n`
  ];
  const fixes = doctorFixes(doctor, providers);
  lines.push(...fixes.map(fix => `fix: ${fix}\n`));
  if (fixes.length === 0) lines.push("next: open Command Center and complete the 10-minute first-delivery checklist\n");
  return lines.join("");
}

function doctorFixes(
  doctor: SystemDoctorDTO,
  providers: NonNullable<SystemDoctorDTO["providers"]>
): string[] {
  const fixes: string[] = [];
  if (!doctor.service?.alive) fixes.push("restart the Runner daemon, then rerun `codex-issue-runner doctor`");
  if (!doctor.db?.ok) fixes.push("run `./scripts/daemon.sh doctor`; restore the authoritative DB from a verified backup if its check fails");
  if (providers.length === 0 || providers.every(provider => !provider.available)) {
    fixes.push("install and sign in to an executor CLI (for Codex, verify `codex --version`), then rerun this command");
  } else {
    const requiredUnavailable = new Set((doctor.health?.reasons || [])
      .filter(reason => reason.code === "provider_unavailable")
      .map(reason => String(reason.source || "").replace(/^provider:/, ""))
      .filter(Boolean));
    for (const provider of providers.filter(item => !item.available && requiredUnavailable.has(String(item.id || "")))) {
      fixes.push(`provider ${provider.id || "unknown"}: install or sign in, verify its CLI, then rerun this command`);
    }
  }
  const warnings = doctor.security?.warnings || [];
  if (warnings.some(warning => warning.code === "bind_all_interfaces")) {
    fixes.push("bind CODEX_RUNNER_ADDR to 127.0.0.1 unless remote access is explicitly required");
  }
  if (warnings.some(warning => warning.code === "auth_disabled")) {
    fixes.push("configure CODEX_RUNNER_AUTH_TOKEN before allowing non-loopback access");
  }
  for (const reason of doctor.health?.reasons || []) {
    const message = String(reason.message || "").trim();
    if (message && !["provider_unavailable", "bind_all_interfaces", "auth_disabled"].includes(String(reason.code || ""))) {
      fixes.push(`${reason.source || reason.code || "health"}: ${message}`);
    }
  }
  return [...new Set(fixes)];
}

function connectorSummary(connectors: SystemStatusDTO["connectors"]): string {
  if (!Array.isArray(connectors) || connectors.length === 0) return "";
  return connectors
    .map((item) => `${item.id || "unknown"}:${item.status || "unknown"}`)
    .join(",");
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

function formatIssueEvent(event: IssueEventDTO): string {
  const parts = [event.created_at, event.type].filter(Boolean).join(" ");
  return `${parts} ${eventText(event)}\n`;
}

function eventText(event: IssueEventDTO): string {
  const payload = (event.payload ?? "").trim();
  if (payload === "") return "";
  try {
    const body = JSON.parse(payload) as { body?: unknown; text?: unknown };
    const text = typeof body.text === "string" ? body.text : body.body;
    if (typeof text === "string" && text.trim() !== "") {
      return redactSensitiveText(text.trim());
    }
  } catch {
    // fall through to raw payload
  }
  return redactSensitiveText(payload);
}
