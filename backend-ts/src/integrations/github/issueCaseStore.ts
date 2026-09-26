import { createHash, randomUUID } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { recordTrackerSyncAudit } from "../../db/repositories/trackerIssueSync.ts";

export type GitHubIssueSource = {
  nodeId: string;
  repositoryId: number;
  repository: string;
  number: number;
  title: string;
  body: string;
  author: string;
  url: string;
  state: "open" | "closed";
  stateReason: string;
  updatedAt: string;
  labels: string[];
};

export type GitHubIssueCase = {
  issue_node_id: string;
  repository_id: number;
  repository: string;
  issue_number: number;
  project_id: string;
  source_revision: number;
  source_fingerprint: string;
  source_json: string;
  external_updated_at: string;
  external_state: string;
  issue_id: number | null;
  work_source_revision: number;
  stage: "intake" | "investigate" | "repair" | "review" | "resolved" | "paused";
  report_json: string;
  pull_request_number: number | null;
  head_sha: string;
  delivery_json: string;
  review_cursor: number;
  review_binding_json: string;
  comment_cursor: number;
  last_error: string;
  created_at: string;
  updated_at: string;
};

export type GitHubWriteCommand = {
  kind: "progress" | "comment" | "close";
  repository: string;
  issueNumber: number;
  issueNodeId: string;
  sourceRevision: number;
  body: string;
  stateReason?: "completed" | "not_planned";
};

export type GitHubWrite = {
  id: number;
  command: GitHubWriteCommand;
  marker: string;
  lease: string;
  attempt: number;
};

export function getGitHubIssueCase(db: RunnerDatabase, nodeId: string): GitHubIssueCase | null {
  return db.sqlite.query<GitHubIssueCase, [string]>("select * from github_issue_cases where issue_node_id=?").get(nodeId);
}

export function listGitHubIssueCases(db: RunnerDatabase, repository: string): GitHubIssueCase[] {
  return db.sqlite.query<GitHubIssueCase, [string]>("select * from github_issue_cases where repository=? order by issue_number").all(repository);
}

export function observeGitHubIssue(db: RunnerDatabase, source: GitHubIssueSource, projectId: string, now = new Date(), intakeLabel?: string): { record: GitHubIssueCase; changed: boolean; created: boolean; stale: boolean } {
  if (!source.nodeId || !Number.isSafeInteger(source.repositoryId) || source.repositoryId <= 0 || !Number.isSafeInteger(source.number) || source.number <= 0 || !Number.isFinite(Date.parse(source.updatedAt))) throw new Error("Invalid GitHub issue identity or version");
  const sourceFingerprint = fingerprint({ title: source.title, body: source.body });
  return db.transaction(() => {
    const previous = getGitHubIssueCase(db, source.nodeId);
    if (previous && previous.project_id !== projectId) throw new Error("GitHub Issue cannot silently move to another Project");
    if (previous && source.updatedAt < previous.external_updated_at) return { record: previous, changed: false, created: false, stale: true };
    const restoredIntake = !!previous && !!intakeLabel && source.labels.includes(intakeLabel) &&
      !(JSON.parse(previous.source_json) as GitHubIssueSource).labels.includes(intakeLabel);
    const changed = !!previous && (previous.source_fingerprint !== sourceFingerprint || (previous.external_state === "closed" && source.state === "open") || restoredIntake);
    const revision = (previous?.source_revision ?? 1) + (changed ? 1 : 0);
    const timestamp = now.toISOString();
    db.sqlite.run(`insert into github_issue_cases
      (issue_node_id, repository_id, repository, issue_number, project_id, source_revision, source_fingerprint, source_json,
       external_updated_at, external_state, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(issue_node_id) do update set repository_id=excluded.repository_id, repository=excluded.repository,
      issue_number=excluded.issue_number, source_revision=excluded.source_revision, source_fingerprint=excluded.source_fingerprint,
      source_json=excluded.source_json, external_updated_at=excluded.external_updated_at, external_state=excluded.external_state,
      updated_at=excluded.updated_at`, [source.nodeId, source.repositoryId, source.repository, source.number, projectId,
      revision, sourceFingerprint, JSON.stringify(source), source.updatedAt, source.state, timestamp, timestamp]);
    if (!previous || changed || previous.external_state !== source.state) auditGitHubCase(db, source.nodeId, projectId,
      changed ? "source_revised" : previous ? "external_state_observed" : "case_created",
      { source_revision: revision, external_state: source.state, state_reason: source.stateReason }, timestamp);
    return { record: getGitHubIssueCase(db, source.nodeId)!, changed, created: !previous, stale: false };
  }).immediate();
}

export function updateGitHubIssueCase(db: RunnerDatabase, nodeId: string, revision: number, patch: Partial<Pick<GitHubIssueCase,
  "issue_id" | "work_source_revision" | "stage" | "report_json" | "pull_request_number" | "head_sha" | "delivery_json" | "review_cursor" | "review_binding_json" | "comment_cursor" | "last_error">>): GitHubIssueCase {
  const allowed = new Set(["issue_id", "work_source_revision", "stage", "report_json", "pull_request_number", "head_sha", "delivery_json", "review_cursor", "review_binding_json", "comment_cursor", "last_error"]);
  const entries = Object.entries(patch);
  if (!entries.length || entries.some(([key]) => !allowed.has(key))) throw new Error("Invalid GitHub case patch");
  const result = db.sqlite.run(`update github_issue_cases set ${entries.map(([key]) => `${key}=?`).join(",")}, updated_at=? where issue_node_id=? and source_revision=?`,
    [...entries.map(([, value]) => value ?? null), new Date().toISOString(), nodeId, revision]);
  if (result.changes !== 1) throw new Error("GitHub case revision changed");
  return getGitHubIssueCase(db, nodeId)!;
}

export function auditGitHubCase(db: RunnerDatabase, nodeId: string, projectId: string, action: string, detail: Record<string, unknown>, at = new Date().toISOString()): void {
  recordTrackerSyncAudit(db, { provider: "github", project_id: projectId, external_id: nodeId,
    action: `github.${action}`, correlation_id: `github:${nodeId}:${action}:${fingerprint(detail)}`, detail }, new Date(at));
}

export function queueGitHubWrite(db: RunnerDatabase, record: GitHubIssueCase, command: GitHubWriteCommand, key: string): number {
  if (command.issueNodeId !== record.issue_node_id || command.sourceRevision !== record.source_revision || command.repository !== record.repository || command.issueNumber !== record.issue_number) throw new Error("GitHub write target or version mismatch");
  const timestamp = new Date().toISOString();
  const payload = JSON.stringify(command);
  // marker 在第一次出站前持久化，用于远端已成功但本地未收到响应时恢复。
  const marker = `<!-- xuanwu-write:${randomUUID()} -->`;
  db.sqlite.run(`insert or ignore into sync_outbox
    (source, issue_id, content, status, created_by, operation_kind, project_id, target_external_id, target_external_type,
     dedupe_key, payload_json, correlation_id, provider_request_ref, created_at, updated_at)
    values ('github', ?, ?, 'queued', 'github-issue-policy', 'github_issue', ?, ?, 'issue', ?, ?, ?, ?, ?, ?)`,
    [record.issue_id ?? 0, command.body, record.project_id, record.issue_node_id, key, payload, key, marker, timestamp, timestamp]);
  const row = db.sqlite.query<{ id: number; payload_json: string }, [string]>("select id, payload_json from sync_outbox where source='github' and operation_kind='github_issue' and dedupe_key=?").get(key)!;
  if (row.payload_json !== payload) throw new Error("GitHub outbox idempotency conflict");
  return row.id;
}

export function claimGitHubWrite(db: RunnerDatabase, repository: string, now = new Date()): GitHubWrite | null {
  return db.transaction(() => {
    const timestamp = now.toISOString();
    const row = db.sqlite.query<{ id: number; payload_json: string; provider_request_ref: string; attempt_count: number }, [string, string, string]>(`
      select id, payload_json, provider_request_ref, attempt_count from sync_outbox
      where source='github' and operation_kind='github_issue' and json_extract(payload_json, '$.repository')=?
      and ((status in ('queued','retry') and (cooldown_until='' or cooldown_until<=?)) or
        (status='sending' and cooldown_until<>'' and cooldown_until<=?)) order by id limit 1
    `).get(repository, timestamp, timestamp);
    if (!row) return null;
    const lease = randomUUID();
    db.sqlite.run("update sync_outbox set status='sending', attempt_count=attempt_count+1, cooldown_until=?, attention_ref=?, updated_at=? where id=?",
      [new Date(now.getTime() + 120000).toISOString(), lease, timestamp, row.id]);
    return { id: row.id, command: JSON.parse(row.payload_json), marker: row.provider_request_ref, lease, attempt: row.attempt_count + 1 };
  }).immediate();
}

export function finishGitHubWrite(db: RunnerDatabase, write: GitHubWrite, outcome: { receipt?: Record<string, unknown>; error?: string; retrySeconds?: number }, now = new Date()): boolean {
  const failed = outcome.error !== undefined;
  const retry = failed && outcome.retrySeconds !== undefined && write.attempt < 8;
  const status = failed ? retry ? "retry" : "failed" : "sent";
  const timestamp = now.toISOString();
  const result = db.sqlite.run(`update sync_outbox set status=?, result_json=?, last_error=?, cooldown_until=?, sent_at=?, updated_at=?
    where id=? and operation_kind='github_issue' and status='sending' and attention_ref=?`,
    [status, JSON.stringify(outcome.receipt ?? {}), outcome.error ?? "", retry ? new Date(now.getTime() + Math.max(1, outcome.retrySeconds!) * 1000).toISOString() : "",
      failed ? "" : timestamp, timestamp, write.id, write.lease]);
  return result.changes === 1;
}

export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
