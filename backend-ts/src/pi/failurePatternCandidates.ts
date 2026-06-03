import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  listPiMemoryItems,
  type PiMemoryItem
} from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { defaultFindingCategory } from "./failedRetryPolicy.ts";
import { containsSensitiveMemoryContent } from "./memoryPolicy.ts";
import type { ProjectFindingCategory } from "./projectFindings.ts";

export type FailurePatternCandidate = PiMemoryItem;

type FailureSignature = { category: ProjectFindingCategory; key: string; match: string };
type FailureSource = {
  details: string[];
  issueID: number;
  key: string;
  runIDs: Set<string>;
  sessionIDs: Set<string>;
};
type SourceRow = Record<string, unknown>;
type CandidateGroup = FailureSignature & { sources: FailureSource[] };
type KnownFailureSignature = FailureSignature & { pattern: RegExp };

const MIN_PATTERN_OCCURRENCES = 2;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f-]{13,}\b/gi;
const NUMBER_PATTERN = /\b\d+\b/g;
const SPACE_PATTERN = /\s+/g;

export function generateFailurePatternMemoryCandidates(db: RunnerDatabase, projectID: string): FailurePatternCandidate[] {
  const id = projectID.trim();
  if (id === "") return [];
  return candidateGroups(failureSources(db, id))
    .filter((group) => group.sources.length >= MIN_PATTERN_OCCURRENCES)
    .filter((group) => !knownFailurePatternExists(db, id, group.match))
    .map((group) => createFailurePatternCandidate(db, id, group))
    .filter((item): item is PiMemoryItem => Boolean(item));
}

function failureSources(db: RunnerDatabase, projectID: string): FailureSource[] {
  const sources = new Map<string, FailureSource>();
  for (const row of issueRows(db, projectID)) addSource(sources, {
    detail: [row.error, row.title], issueID: integer(row.issue_id), sessionID: text(row.session_id)
  });
  for (const row of runRows(db, projectID)) addSource(sources, {
    detail: [row.error, row.exit_reason], issueID: integer(row.issue_id), runID: text(row.run_id),
    sessionID: text(row.session_id)
  });
  for (const row of sessionRows(db, projectID)) addSource(sources, {
    detail: [row.preview, row.title], issueID: integer(row.issue_id), sessionID: text(row.session_id)
  });
  return [...sources.values()].filter((source) => source.details.length > 0);
}

function candidateGroups(sources: FailureSource[]): CandidateGroup[] {
  const groups = new Map<string, CandidateGroup>();
  for (const source of sources) {
    const signature = classifyFailure(source.details.join("\n"));
    if (!signature) continue;
    const group = groups.get(signature.key) ?? { ...signature, sources: [] };
    group.sources.push(source);
    groups.set(signature.key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sources: group.sources.sort((left, right) => left.key.localeCompare(right.key))
  }));
}

function createFailurePatternCandidate(
  db: RunnerDatabase,
  projectID: string,
  group: CandidateGroup
): PiMemoryItem | undefined {
  const content = JSON.stringify(candidateContent(group));
  if (containsSensitiveMemoryContent(content)) return undefined;
  try {
    return createPiMemoryItem(db, {
      id: `failure-pattern-${slug(projectID)}-${hashText(group.key)}`,
      scope: "project",
      scope_id: projectID,
      kind: "failure_pattern",
      content,
      source_type: "failure_pattern_scan",
      source_id: sourceID(group.sources),
      confidence: group.sources.length >= 3 ? "medium" : "low",
      disabled: 1
    });
  } catch {
    return undefined;
  }
}

function addSource(map: Map<string, FailureSource>, input: {
  detail: unknown[]; issueID: number; runID?: string; sessionID?: string;
}): void {
  const key = input.issueID > 0 ? `issue:${input.issueID}` : `session:${input.sessionID ?? ""}`;
  if (key === "session:") return;
  const source = map.get(key) ?? { details: [], issueID: input.issueID, key, runIDs: new Set(), sessionIDs: new Set() };
  source.details.push(...input.detail.map(redactedDetail).filter(Boolean));
  if (input.runID) source.runIDs.add(input.runID);
  if (input.sessionID) source.sessionIDs.add(input.sessionID);
  map.set(key, source);
}

function classifyFailure(detail: string): FailureSignature | undefined {
  const normalized = normalizeFailureText(detail);
  if (normalized === "") return undefined;
  const known = knownSignature(normalized);
  if (known) return known;
  return {
    category: defaultFindingCategory({ autoRetryNextAt: "", detail: normalized, status: "failed" }),
    key: `exact:${normalized}`,
    match: normalized.slice(0, 96)
  };
}

function knownSignature(text: string): FailureSignature | undefined {
  return KNOWN_SIGNATURES.find((item) => item.pattern.test(text));
}

function candidateContent(group: CandidateGroup): Record<string, unknown> {
  return {
    category: group.category,
    match: group.match,
    occurrence_count: group.sources.length,
    recommendation: recommendation(group.category),
    sources: group.sources.map(sourceSummary)
  };
}

function sourceSummary(source: FailureSource): Record<string, unknown> {
  const sessions = sorted(source.sessionIDs);
  return {
    issue_id: source.issueID,
    run_ids: sorted(source.runIDs),
    session_id: sessions[0] ?? "",
    session_ids: sessions
  };
}

function knownFailurePatternExists(db: RunnerDatabase, projectID: string, match: string): boolean {
  return [
    ...listPiMemoryItems(db, { scope: "project", scopeId: projectID }),
    ...listPiMemoryItems(db, { scope: "global" })
  ].some((item) => item.kind === "failure_pattern" && memoryMatch(item) === match);
}

function memoryMatch(item: PiMemoryItem): string {
  try {
    const parsed = JSON.parse(item.content) as Record<string, unknown>;
    return text(parsed.match || parsed.pattern || parsed.needle);
  } catch {
    return item.content.trim();
  }
}

function issueRows(db: RunnerDatabase, projectID: string): SourceRow[] {
  return db.sqlite.query<SourceRow, [string]>(`
    select id as issue_id, error, title, codex_thread_id as session_id
    from issues where project_id=? and status='failed'
  `).all(projectID);
}

function runRows(db: RunnerDatabase, projectID: string): SourceRow[] {
  return db.sqlite.query<SourceRow, [string]>(`
    select ir.id as run_id, ir.issue_id, ir.error, ir.exit_reason, ir.provider_session_id as session_id
    from issue_runs ir join issues i on i.id=ir.issue_id
    where i.project_id=? and lower(ir.status) in ('failed', 'error', 'failure')
  `).all(projectID);
}

function sessionRows(db: RunnerDatabase, projectID: string): SourceRow[] {
  return db.sqlite.query<SourceRow, [string]>(`
    select issue_id, provider_session_id as session_id, title, preview
    from agent_sessions where project_id=? and lower(status) in ('failed', 'error', 'failure')
  `).all(projectID);
}

function normalizeFailureText(value: string): string {
  return value.toLowerCase()
    .replace(ABSOLUTE_PATH_PATTERN, " ")
    .replace(UUID_PATTERN, " ")
    .replace(NUMBER_PATTERN, " ")
    .replace(/[^a-z0-9._/-]+/g, " ")
    .replace(SPACE_PATTERN, " ")
    .trim();
}

function redactedDetail(value: unknown): string {
  const detail = redactSensitiveText(text(value)).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]").trim();
  return detail.includes("[redacted sensitive line]") ? "" : detail;
}

function recommendation(category: ProjectFindingCategory): string {
  if (category === "needs_user") return "Escalate repeated failure to user before retrying.";
  if (category === "transient") return "Retry only after confirming the transient runtime/provider condition has cleared.";
  if (category === "verification_needed") return "Collect verification evidence before marking related issues done.";
  return "Review repeated failure pattern before retrying.";
}

function sourceID(sources: FailureSource[]): string {
  return sources.flatMap((source) => [
    source.issueID > 0 ? `issue:${source.issueID}` : "",
    ...sorted(source.sessionIDs).map((id) => `session:${id}`)
  ]).filter(Boolean).join(",");
}

function sorted(values: Set<string>): string[] {
  return [...values].filter(Boolean).sort();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

const KNOWN_SIGNATURES: KnownFailureSignature[] = [
  { category: "needs_user", key: "provider:quota_exhaustion", match: "quota exhaustion", pattern: /quota exhaustion/ },
  { category: "needs_user", key: "provider:quota_exceeded", match: "quota exceeded", pattern: /quota exceeded/ },
  { category: "needs_user", key: "provider:rate_limit", match: "rate limit", pattern: /rate limit/ },
  { category: "needs_user", key: "provider:too_many_requests", match: "too many requests", pattern: /too many requests/ },
  { category: "needs_user", key: "provider:http_429", match: "api returned 429", pattern: /api returned 429/ },
  { category: "transient", key: "runtime:unexpected_eof", match: "unexpected eof", pattern: /unexpected eof/ },
  { category: "transient", key: "runtime:stream_disconnected", match: "stream disconnected", pattern: /stream disconnected/ },
  { category: "transient", key: "runtime:connection_reset", match: "connection reset", pattern: /connection reset/ },
  { category: "transient", key: "runtime:transport_error", match: "transport error", pattern: /transport error/ },
  { category: "transient", key: "runtime:network_error", match: "network error", pattern: /network error/ },
  { category: "transient", key: "runtime:command_timeout", match: "command timed out", pattern: /command timed out/ },
  { category: "transient", key: "runtime:deadline_exceeded", match: "deadline exceeded", pattern: /deadline exceeded/ },
  { category: "transient", key: "runtime:timeout", match: "timeout", pattern: /\btimeout\b/ },
  { category: "transient", key: "runtime:timed_out", match: "timed out", pattern: /timed out/ },
  { category: "needs_user", key: "access:approval_denied", match: "approval denied", pattern: /approval denied/ },
  { category: "needs_user", key: "access:permission_denied", match: "permission denied", pattern: /permission denied/ },
  { category: "needs_user", key: "access:authentication_failed", match: "authentication failed", pattern: /authentication failed/ },
  { category: "needs_user", key: "access:http_401", match: "api returned 401", pattern: /api returned 401/ },
  { category: "needs_user", key: "access:unauthorized", match: "unauthorized", pattern: /unauthorized/ },
  { category: "verification_needed", key: "verification:failed", match: "verification failed", pattern: /verification failed/ },
  { category: "verification_needed", key: "verification:test_failed", match: "test failed", pattern: /test failed/ },
  { category: "verification_needed", key: "verification:tests_failed", match: "tests failed", pattern: /tests failed/ },
  { category: "verification_needed", key: "verification:missing", match: "missing verification", pattern: /missing verification/ }
];
