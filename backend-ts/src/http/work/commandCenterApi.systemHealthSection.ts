import type { RunnerDatabase } from "../../db/database.ts";
import { readWorkSummary } from "../../db/repositories/workSummary.ts";
import { eventProjectionStatusForRead } from "../../db/repositories/compactEventSummaryProjection.ts";
import { countRunsByStatus } from "../../db/repositories/runs.ts";
import { HttpError } from "../errors.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import type { CommandCenterRouteOptions, CommandCenterSummary, CommandCenterSectionName, CommandCenterSectionResult, CommandCenterSectionReaders, SectionInput, CommandCenterSectionPayload, CommandCenterSectionReader, CommandCenterFreshness } from "./commandCenterApi.model.ts";
import { requestInput, freshness } from "./commandCenterApi.attentionDetails.ts";
import { COMMAND_CENTER_COMPATIBILITY_POLICY, COMMAND_CENTER_SUMMARY_CONTRACT, DEFAULT_LIMIT, MAX_LIMIT } from "./commandCenterApi.piActionAttentionDetails.ts";
import { activeWorkSection, attentionSection, recentDeliveriesSection } from "./commandCenterApi.attentionSection.ts";

export function buildCommandCenterSummary(
  context: ReadApiContext,
  request: Request,
  options: CommandCenterRouteOptions = {}
): CommandCenterSummary {
  const input = requestInput(request);
  const now = options.now?.() ?? new Date();
  const defaults = commandCenterSectionReaders(context.readDatabase ?? context.database, context);
  const readers = { ...defaults, ...options.readers };
  const sections: Partial<Record<CommandCenterSectionName, CommandCenterSectionResult>> = {};
  const failedSections: CommandCenterSectionName[] = [];
  for (const section of input.sections) {
    sections[section] = readSection(section, readers[section], { limit: input.limit, now });
    if (sections[section]?.status === "error") failedSections.push(section);
  }
  return {
    compatibility: COMMAND_CENTER_COMPATIBILITY_POLICY,
    contract: COMMAND_CENTER_SUMMARY_CONTRACT,
    failed_sections: failedSections,
    generated_at: now.toISOString(),
    limits: { default: DEFAULT_LIMIT, maximum: MAX_LIMIT, requested: input.limit },
    partial: failedSections.length > 0,
    requested_sections: input.sections,
    sections
  };
}

export function commandCenterSectionReaders(db: RunnerDatabase, context: ReadApiContext = { database: db }): CommandCenterSectionReaders {
  return {
    active_work: (input) => activeWorkSection(db, input, context),
    attention: (input) => attentionSection(db, input),
    recent_deliveries: (input) => recentDeliveriesSection(db, input),
    system_health: (input) => systemHealthSection(db, input)
  };
}

export function systemHealthSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  db.sqlite.query("select 1 as ok").get();
  const runCounts = countRunsByStatus(db);
  const projection = eventProjectionStatusForRead(db);
  const totalRuns = Object.values(runCounts).reduce((total, count) => total + count, 0);
  const unknownWorkStatuses = readWorkSummary(db, { includeProjects: false }).counts.unknown_status_count;
  const degraded = projection.status !== "ready" || unknownWorkStatuses > 0;
  return {
    counts: {
      ...runCounts,
      total: totalRuns
    },
    freshness: freshness(input.now, [input.now.toISOString()], 60),
    links: {
      doctor: "/api/system/doctor",
      runs: "/api/runs",
      status: "/api/system/status"
    },
    summary: {
      database: { status: "ready" },
      warnings: unknownWorkStatuses > 0 ? [{
        code: "work_status_unknown",
        count: unknownWorkStatuses,
        source: "issues.status"
      }] : [],
      event_projection: {
        lag_rows: projection.lag_rows,
        last_event_id: projection.last_event_id,
        source_last_event_id: projection.source_last_event_id,
        status: projection.status,
        updated_at: projection.updated_at
      },
      overall: degraded ? "degraded" : "healthy",
      run_progress: {
        active_runs: runCounts.running + runCounts.recovering,
        projection_mode: "read_through_rebuild",
        recovering_runs: runCounts.recovering,
        source_of_truth: "issue_runs+run_attempts+issue_events"
      }
    }
  };
}

export function compactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

export function routeValue(request: Request, before: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = parts.indexOf(before);
  const value = index >= 0 ? parts[index + 1] : "";
  if (!value) throw new HttpError(400, `${before} route value is required`);
  return decodeURIComponent(value);
}

export function readSection(
  section: CommandCenterSectionName,
  reader: CommandCenterSectionReader,
  input: SectionInput
): CommandCenterSectionResult {
  try {
    return { ...reader(input), status: "ok" };
  } catch {
    return {
      error: { code: "section_unavailable", message: `${section} query failed` },
      freshness: unknownFreshness(input.now),
      links: sectionLinks(section),
      status: "error"
    };
  }
}

export function unknownFreshness(now: Date): CommandCenterFreshness {
  return {
    is_stale: true,
    queried_at: now.toISOString(),
    source_updated_at: "",
    stale_after_seconds: 0,
    state: "unknown"
  };
}

export function sectionLinks(section: CommandCenterSectionName): Record<string, string> {
  if (section === "attention") return { collection: "/api/pi/attention-inbox/items" };
  if (section === "active_work") return { collection: "/api/works", runs: "/api/runs" };
  if (section === "recent_deliveries") return { collection: "/api/handoffs" };
  return { status: "/api/system/status" };
}
