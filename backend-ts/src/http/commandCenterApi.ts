import type { RunnerDatabase } from "../db/database.ts";
import {
  countStoredHandoffs,
  listStoredHandoffs,
  type StoredHandoffRecord
} from "../db/repositories/handoffs.ts";
import {
  countAttentionInboxItems,
  listAttentionInboxItems,
  type AttentionInboxItemRecord,
  type AttentionInboxItemStatus
} from "../db/repositories/intakeRuns.ts";
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
import { json } from "./errors.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";

export const COMMAND_CENTER_SUMMARY_CONTRACT = "xw.command-center.summary.v1" as const;

export const COMMAND_CENTER_COMPATIBILITY_POLICY = {
  attention_read_authority: "attention_inbox_items-compatibility-projection-until-P08.07",
  dual_read: "none-request-time-projection-over-current-authorities",
  dual_write: "none-read-only-aggregate",
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
const ACTIVE_ATTENTION_STATUSES: AttentionInboxItemStatus[] = ["new", "triaged", "proposal_created", "failed"];
const RECENT_HANDOFF_STATUSES = ["draft", "ready", "delivered"];

export function registerCommandCenterRoutes(
  router: Router,
  context: ReadApiContext,
  options: CommandCenterRouteOptions = {}
): void {
  router.get("/api/command-center/summary", (request) => commandCenterResponse(() => (
    buildCommandCenterSummary(context, request, options)
  )));
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
  const filter = { statuses: ACTIVE_ATTENTION_STATUSES };
  const items = listAttentionInboxItems(db, { ...filter, limit: input.limit });
  return {
    counts: {
      returned: items.length,
      total: countAttentionInboxItems(db, filter)
    },
    freshness: freshness(input.now, items.map((item) => item.updated_at), 5 * 60),
    items: items.map(attentionSummary),
    links: { collection: "/api/pi/attention-inbox/items" }
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

function attentionSummary(item: AttentionInboxItemRecord): Record<string, unknown> {
  return {
    confidence: item.confidence,
    created_at: item.created_at,
    id: makeDomainID("attention", "attention_inbox_items", item.id),
    legacy_id: item.id,
    links: {
      context_bundle: `/api/pi/attention-inbox/context-bundles/${item.bundle_id}`,
      intake_run: `/api/pi/attention-inbox/intake-runs/${item.intake_run_id}`,
      self: `/api/pi/attention-inbox/items/${item.id}`
    },
    primary_intent: item.primary_intent,
    source: item.source,
    status: canonicalAttentionStatus(item.status),
    legacy_status: item.status,
    suggested_actions: item.suggested_actions,
    summary: boundedText(item.summary),
    title: item.title,
    updated_at: item.updated_at,
    urgency: item.urgency
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

function canonicalAttentionStatus(status: string): "acknowledged" | "open" | "waiting" {
  if (status === "triaged") return "acknowledged";
  if (status === "proposal_created") return "waiting";
  return "open";
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
