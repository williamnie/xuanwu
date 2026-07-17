import type { RunnerDatabase } from "../db/database.ts";
import {
  countStoredHandoffs,
  listStoredHandoffs,
  type StoredHandoffRecord
} from "../db/repositories/handoffs.ts";
import {
  getPersistedAttention,
  listPersistedAttention,
  persistAttentionCommand
} from "../domain/attention/persistence.ts";
import type { AttentionCommand, AttentionRecord, AttentionTransitionAudit } from "../domain/attention/contracts.ts";
import { eventProjectionStatus } from "../db/repositories/eventSummaryProjection.ts";
import {
  countRunsByStatus,
  listLatestRunsForWorkIDs,
  type RunView
} from "../db/repositories/runs.ts";
import {
  countIssueBackedWorks,
  listIssueBackedWorks,
  workIDToIssueID
} from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry, WorkStatus } from "../domain/work/contracts.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

export const COMMAND_CENTER_SUMMARY_CONTRACT = "xw.command-center.summary.v1" as const;

export const COMMAND_CENTER_COMPATIBILITY_POLICY = {
  attention_command_audit_authority: "attention_command_events-append-only-overlay",
  attention_read_authority: "legacy-attention-adapters-with-command-overlay",
  dual_read: "none-request-time-projection-over-current-authorities",
  dual_write: "none-legacy-facts-remain-single-writer",
  final_removal_gate: "P07.03/P07.04/P07.05-migrated-and-legacy-Dashboard-zero-consumer-for-one-release",
  handoff_read_authority: "issue_events:handoff.*.v1",
  rollback: "unregister-command-center-route-and-restore-bounded-legacy-Dashboard-reads-without-data-migration",
  run_read_authority: "issue_runs+run_attempts+issue_events-read-through-progress",
  work_read_authority: "issues-via-Work-adapter"
} as const;

export const COMMAND_CENTER_SECTIONS = [
  "attention",
  "active_work",
  "recent_deliveries",
  "system_health"
] as const;

export type CommandCenterSectionName = typeof COMMAND_CENTER_SECTIONS[number];

export type CommandCenterFreshness = {
  is_stale: boolean;
  queried_at: string;
  source_updated_at: string;
  stale_after_seconds: number;
  state: "current" | "empty" | "stale" | "unknown";
};

export type CommandCenterSectionPayload = {
  counts: Record<string, number>;
  freshness: CommandCenterFreshness;
  items?: unknown[];
  links: Record<string, string>;
  summary?: Record<string, unknown>;
};

export type CommandCenterSectionResult = (CommandCenterSectionPayload & { status: "ok" }) | {
  error: { code: "section_unavailable"; message: string };
  freshness: CommandCenterFreshness;
  links: Record<string, string>;
  status: "error";
};

export type CommandCenterSummary = {
  compatibility: typeof COMMAND_CENTER_COMPATIBILITY_POLICY;
  contract: typeof COMMAND_CENTER_SUMMARY_CONTRACT;
  failed_sections: CommandCenterSectionName[];
  generated_at: string;
  limits: { default: number; maximum: number; requested: number };
  partial: boolean;
  requested_sections: CommandCenterSectionName[];
  sections: Partial<Record<CommandCenterSectionName, CommandCenterSectionResult>>;
};

type SectionInput = { limit: number; now: Date };
export type CommandCenterSectionReader = (input: SectionInput) => CommandCenterSectionPayload;
export type CommandCenterSectionReaders = Record<CommandCenterSectionName, CommandCenterSectionReader>;

type CommandCenterRouteOptions = {
  now?: () => Date;
  readers?: Partial<CommandCenterSectionReaders>;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const SUMMARY_TEXT_LIMIT = 320;
const ACTIVE_WORK_STATUSES: WorkStatus[] = ["todo", "in_progress", "pending_verification"];
const RECENT_HANDOFF_STATUSES = ["draft", "ready", "delivered"];

export function registerCommandCenterRoutes(
  router: Router,
  context: ReadApiContext,
  options: CommandCenterRouteOptions = {}
): void {
  router.get("/api/command-center/summary", (request) => commandCenterResponse(() => (
    buildCommandCenterSummary(context, request, options)
  )));
  router.post("/api/command-center/attention/:id/actions/:action", async (request) => (
    attentionCommandResponse(context.database, request)
  ));
}

export function buildCommandCenterSummary(
  context: ReadApiContext,
  request: Request,
  options: CommandCenterRouteOptions = {}
): CommandCenterSummary {
  const input = requestInput(request);
  const now = options.now?.() ?? new Date();
  const defaults = commandCenterSectionReaders(context.database);
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

export function commandCenterSectionReaders(db: RunnerDatabase): CommandCenterSectionReaders {
  return {
    active_work: (input) => activeWorkSection(db, input),
    attention: (input) => attentionSection(db, input),
    recent_deliveries: (input) => recentDeliveriesSection(db, input),
    system_health: (input) => systemHealthSection(db, input)
  };
}

function attentionSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const all = listPersistedAttention(db).filter((item) => item.status !== "resolved" && item.status !== "dismissed");
  const items = all.slice(0, input.limit);
  return {
    counts: {
      returned: items.length,
      total: all.length
    },
    freshness: freshness(input.now, all.map((item) => item.updated_at), 5 * 60),
    items: items.map(attentionSummary),
    links: { collection: "/api/command-center/summary?sections=attention" }
  };
}

function activeWorkSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const filter = {
    limit: input.limit,
    offset: 0,
    sort: "updated_at" as const,
    sortOrder: "desc" as const,
    statuses: ACTIVE_WORK_STATUSES
  };
  const works = listIssueBackedWorks(db, filter);
  const runs = listLatestRunsForWorkIDs(db, works.map((work) => work.id));
  const runByWorkID = new Map(runs.map((run) => [run.work_id, run]));
  const sourceTimestamps = works.flatMap((work) => {
    const run = runByWorkID.get(work.id);
    return [work.updated_at, run?.updated_at ?? ""];
  });
  return {
    counts: {
      returned: works.length,
      total: countIssueBackedWorks(db, { statuses: ACTIVE_WORK_STATUSES })
    },
    freshness: freshness(input.now, sourceTimestamps, 15 * 60),
    items: works.map((work) => activeWorkSummary(work, runByWorkID.get(work.id))),
    links: { collection: "/api/works", runs: "/api/runs" }
  };
}

function recentDeliveriesSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const filter = { statuses: RECENT_HANDOFF_STATUSES };
  const page = listStoredHandoffs(db, { ...filter, limit: input.limit });
  return {
    counts: {
      returned: page.items.length,
      skipped_invalid: page.skipped_invalid,
      total: countStoredHandoffs(db, filter)
    },
    freshness: freshness(input.now, page.items.map((record) => record.handoff.updated_at), 5 * 60),
    items: page.items.map(handoffSummary),
    links: { collection: "/api/handoffs" }
  };
}

function systemHealthSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  db.sqlite.query("select 1 as ok").get();
  const runCounts = countRunsByStatus(db);
  const projection = eventProjectionStatus(db);
  const totalRuns = Object.values(runCounts).reduce((total, count) => total + count, 0);
  const degraded = projection.status !== "ready";
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

function attentionSummary(item: AttentionRecord): Record<string, unknown> {
  const primary = item.source_refs[0];
  return {
    created_at: item.created_at,
    id: item.id,
    links: {
      action: `/api/command-center/attention/${encodeURIComponent(item.id)}/actions`,
      self: attentionSourceLink(primary.authority, primary.local_id),
      view: primary.authority === "attention_inbox_items" ? "#/attention-inbox" : "#/command-center"
    },
    next_action: item.next_action,
    priority: item.priority,
    required_actor: item.required_actor,
    revision: item.revision,
    snoozed_until: item.snoozed_until,
    source_refs: item.source_refs,
    status: item.status,
    summary: boundedText(item.summary),
    type: item.type,
    updated_at: item.updated_at,
    severity: item.severity
  };
}

function activeWorkSummary(work: WorkLedgerEntry, run: RunView | undefined): Record<string, unknown> {
  const issueID = workIDToIssueID(work.id);
  return {
    id: work.id,
    latest_run: run ? runSummary(run) : null,
    links: {
      issue: `/api/issues/${issueID}`,
      project: `/api/projects/${encodeURIComponent(work.owner.project_id)}`,
      runs: `/api/runs?work_id=${encodeURIComponent(work.id)}`,
      self: `/api/works/${encodeURIComponent(work.id)}`
    },
    project_id: work.owner.project_id,
    revision: work.revision,
    status: work.status,
    title: work.title,
    updated_at: work.updated_at
  };
}

function runSummary(run: RunView): Record<string, unknown> {
  return {
    id: run.id,
    phase: run.progress.provider_phase,
    progress: {
      latest: run.progress.latest,
      stalled: run.progress.stalled,
      updated_at: run.progress.updated_at
    },
    provider: run.provider,
    status: run.status,
    updated_at: run.updated_at
  };
}

function handoffSummary(record: StoredHandoffRecord): Record<string, unknown> {
  const handoff = record.handoff;
  return {
    delivery: handoff.delivery,
    evidence_count: handoff.evidence_ids.length,
    id: handoff.id,
    links: {
      evidence: `/api/evidence?work_id=${encodeURIComponent(handoff.work_id)}`,
      self: `/api/handoffs/${encodeURIComponent(handoff.id)}`,
      view: `#/handoffs/${encodeURIComponent(handoff.id)}`,
      work: `/api/works/${encodeURIComponent(handoff.work_id)}`
    },
    project_id: record.project_id,
    review: handoff.review,
    risk_count: handoff.risks.length,
    status: handoff.status,
    summary: boundedText(handoff.summary),
    updated_at: handoff.updated_at,
    work_id: handoff.work_id
  };
}

function attentionSourceLink(authority: string, localID: string): string {
  if (authority === "attention_inbox_items") return `/api/pi/attention-inbox/items/${encodeURIComponent(localID)}`;
  if (authority === "pi_guardian_alerts") return "/api/pi/guardian/alerts?status=all";
  if (authority === "pi_approval_requests") return "/api/pi/approval-requests?status=open";
  return "/api/issues";
}

async function attentionCommandResponse(db: RunnerDatabase, request: Request): Promise<Response> {
  const id = routeValue(request, "attention");
  const action = routeValue(request, "actions");
  if (action !== "acknowledge" && action !== "snooze") throw new HttpError(400, "unsupported Attention action");
  if (!getPersistedAttention(db, id)) throw new HttpError(404, "Attention not found");
  const body = await parseJsonBody(request);
  const command = attentionCommandInput(action, body);
  try {
    const result = persistAttentionCommand(db, id, command);
    return json({ attention: attentionSummary(result.attention), mutation: { audit_event: result.audit_event, replayed: false } });
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "Attention command failed");
  }
}

function attentionCommandInput(action: "acknowledge" | "snooze", value: unknown): AttentionCommand {
  const body = objectValue(value, "Attention command body");
  const expectedRevision = body.expected_revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new HttpError(400, "expected_revision must be a non-negative integer");
  }
  const audit = objectValue(body.audit, "audit") as AttentionTransitionAudit;
  if (!audit.actor || !audit.gate || typeof audit.event_id !== "string" || typeof audit.reason !== "string" ||
      typeof audit.correlation_id !== "string" || typeof audit.occurred_at !== "string") {
    throw new HttpError(400, "invalid Attention audit");
  }
  if (action === "snooze" && typeof body.snoozed_until !== "string") {
    throw new HttpError(400, "snoozed_until is required for snooze");
  }
  return {
    action,
    audit,
    expected_revision: expectedRevision,
    ...(action === "snooze" ? { snoozed_until: body.snoozed_until as string } : {})
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function routeValue(request: Request, before: string): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const index = parts.indexOf(before);
  const value = index >= 0 ? parts[index + 1] : "";
  if (!value) throw new HttpError(400, `${before} route value is required`);
  return decodeURIComponent(value);
}

function readSection(
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

function requestInput(request: Request): { limit: number; sections: CommandCenterSectionName[] } {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit")?.trim() ?? "";
  const limit = rawLimit === "" ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
    throw new CommandCenterHttpError(400, "invalid_limit", `limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  const rawSections = params.getAll("sections").flatMap((value) => value.split(","))
    .map((value) => value.trim()).filter(Boolean);
  const sections = rawSections.length === 0
    ? [...COMMAND_CENTER_SECTIONS]
    : [...new Set(rawSections.map(commandCenterSection))];
  return { limit, sections };
}

function commandCenterSection(value: string): CommandCenterSectionName {
  if (COMMAND_CENTER_SECTIONS.includes(value as CommandCenterSectionName)) return value as CommandCenterSectionName;
  throw new CommandCenterHttpError(400, "invalid_section", `unknown Command Center section: ${value}`);
}

function freshness(now: Date, timestamps: string[], staleAfterSeconds: number): CommandCenterFreshness {
  const sourceUpdatedAt = timestamps.filter(validTimestamp).sort().at(-1) ?? "";
  if (sourceUpdatedAt === "") {
    return {
      is_stale: false,
      queried_at: now.toISOString(),
      source_updated_at: "",
      stale_after_seconds: staleAfterSeconds,
      state: "empty"
    };
  }
  const stale = now.getTime() - Date.parse(sourceUpdatedAt) > staleAfterSeconds * 1000;
  return {
    is_stale: stale,
    queried_at: now.toISOString(),
    source_updated_at: sourceUpdatedAt,
    stale_after_seconds: staleAfterSeconds,
    state: stale ? "stale" : "current"
  };
}

function unknownFreshness(now: Date): CommandCenterFreshness {
  return {
    is_stale: true,
    queried_at: now.toISOString(),
    source_updated_at: "",
    stale_after_seconds: 0,
    state: "unknown"
  };
}

function sectionLinks(section: CommandCenterSectionName): Record<string, string> {
  if (section === "attention") return { collection: "/api/pi/attention-inbox/items" };
  if (section === "active_work") return { collection: "/api/works", runs: "/api/runs" };
  if (section === "recent_deliveries") return { collection: "/api/handoffs" };
  return { status: "/api/system/status" };
}

function validTimestamp(value: string): boolean {
  return value.trim() !== "" && Number.isFinite(Date.parse(value));
}

function boundedText(value: string): string {
  return value.length <= SUMMARY_TEXT_LIMIT ? value : `${value.slice(0, SUMMARY_TEXT_LIMIT - 1)}…`;
}

class CommandCenterHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function commandCenterResponse(read: () => unknown | Promise<unknown>): Promise<Response> {
  try {
    return json(await read());
  } catch (error) {
    if (error instanceof CommandCenterHttpError) {
      return json({ code: error.code, message: error.message }, { status: error.status });
    }
    throw error;
  }
}
