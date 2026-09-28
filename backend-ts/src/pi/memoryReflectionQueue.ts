import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { listStoredEvidence } from "../db/repositories/evidence.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { canSatisfyEvidenceGate } from "../domain/evidence/contracts.ts";
import { redactSensitiveText } from "../util/redact.ts";

export const REFLECTION_LIMITS = {
  timeoutMs: 45_000, leaseMs: 60_000, maxAttempts: 2, summaryBytes: 48_000, inputBytes: 128_000,
  outputBytes: 16_000, outputTokens: 3_000, modelCalls: 4, toolCalls: 6
} as const;

export type ReflectionSummary = {
  project_id: string; work_id: string; run_id: string; outcome: "accepted" | "failed";
  title: string; rationale: string;
  evidence: Array<{ id: string; status: string; summary: string; excerpt: string; source: string }>;
};
export type MemoryReflection = {
  id: string; project_id: string; issue_id: number; run_id: string; fingerprint: string;
  summary_json: string; status: "pending" | "running" | "completed" | "skipped" | "failed";
  attempts: number; lease_token: string; lease_until: number; reason: string; memory_id: string;
};
export type ReflectionLease = { id: string; token: string };

export function memoryReflectionEnabled(db: RunnerDatabase, projectID: string): boolean {
  return db.sqlite.query<{ enabled: number }, [string]>(
    "select enabled from pi_memory_reflection_settings where project_id=?"
  ).get(projectID)?.enabled === 1;
}

// 同一来源的已遗忘经验不能通过下一次证据指纹、更换 key 自动复活。
export function reflectionSourceSuppressed(db: RunnerDatabase, projectID: string, runID: string): boolean {
  return Boolean(db.sqlite.query<{ id: string }, [string, string]>(`
    select r.id from pi_memory_reflections r join pi_memory_suppressions s on s.memory_id=r.memory_id
    where r.project_id=? and r.run_id=? limit 1
  `).get(projectID, runID));
}

export function setMemoryReflectionEnabled(db: RunnerDatabase, projectID: string, enabled: boolean): void {
  db.transaction(() => {
    db.sqlite.run(`insert into pi_memory_reflection_settings values (?, ?, (select coalesce(max(id), 0) from issue_events), ?)
      on conflict(project_id) do update set enabled=excluded.enabled,
        after_event_id=case when pi_memory_reflection_settings.enabled=0 and excluded.enabled=1
          then excluded.after_event_id else pi_memory_reflection_settings.after_event_id end,
        updated_at=excluded.updated_at`, [projectID, enabled ? 1 : 0, new Date().toISOString()]);
    if (!enabled) db.sqlite.run(`update pi_memory_reflections set status='skipped', reason='project_disabled',
      lease_token='', lease_until=0, updated_at=? where project_id=? and status in ('pending', 'running')`,
    [new Date().toISOString(), projectID]);
  }).immediate();
}

// 只读指定 Work/Run 的结构化摘要；不读取 Provider 日志、仓库或完整项目历史。
export function requestMemoryReflection(db: RunnerDatabase, issueID: number): void {
  // 与项目关闭/重新启用串行，避免关闭后迟到入队的请求在下一次启用时复活。
  db.transaction(() => enqueueMemoryReflection(db, issueID)).immediate();
}

function enqueueMemoryReflection(db: RunnerDatabase, issueID: number): void {
  const issue = getIssue(db, issueID);
  if (!issue || !["done", "failed"].includes(issue.status) || !memoryReflectionEnabled(db, issue.project_id)) return;
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run?.ended_at || !["succeeded", "failed", "cancelled"].includes(run.status)) return;
  const accepted = db.sqlite.query<{ payload: string }, [string, number, string]>(`
    select e.payload from issue_events e join pi_memory_reflection_settings s on s.project_id=?
    where e.issue_id=? and e.type='issue.pi_acceptance_applied.v1' and e.id>s.after_event_id
      and json_valid(e.payload) and json_extract(e.payload, '$.run_id')=?
    order by e.id desc limit 1
  `).get(issue.project_id, issueID, run.id);
  if (!accepted) return;
  const applied = JSON.parse(accepted.payload);
  if (!applied || applied.action !== (issue.status === "done" ? "accept" : "failed")) return;
  const workID = `xw:work:issues:${issueID}`;
  const runID = `xw:run:issue_runs:${run.id}`;
  const page = listStoredEvidence(db, { issue_ids: [issueID], run_ids: [runID], limit: 16 });
  const evidence = page.items.map(item => item.evidence).filter(item =>
    !["agent_claim", "legacy_import"].includes(item.provenance.assertion_origin)
    && !db.sqlite.query<{ id: number }, [number, string]>(`select id from issue_events where issue_id=?
      and type in ('evidence.recorded.v1', 'issue.verification_human_evidence.v1') and json_valid(payload)
      and json_extract(payload, '$.evidence.supersedes_id')=? limit 1`).get(issueID, item.id)
    && ["passed", "failed"].includes(item.status)
  ).sort((a, b) => a.id.localeCompare(b.id));
  const fingerprint = createHash("sha256").update(JSON.stringify([issue.status, evidence])).digest("hex");
  const summary: ReflectionSummary = {
    project_id: issue.project_id, work_id: workID, run_id: runID,
    outcome: issue.status === "done" ? "accepted" : "failed",
    title: redactSensitiveText(issue.title).slice(0, 512),
    rationale: redactSensitiveText(String(applied.decision?.rationale ?? "")).slice(0, 2000),
    evidence: evidence.map(item => ({ id: item.id, status: item.status,
      summary: redactSensitiveText(item.decisive_output.summary).slice(0, 1024),
      excerpt: redactSensitiveText(item.decisive_output.excerpt ?? "").slice(0, 1024),
      source: redactSensitiveText(item.provenance.source_ref).slice(0, 256) }))
  };
  const summaryJSON = JSON.stringify(summary);
  const validEvidence = evidence.length > 0 && (issue.status === "failed"
    || evidence.some(item => canSatisfyEvidenceGate(item) && (item.decisive_output.exit_code ?? 0) === 0));
  const reason = reflectionSourceSuppressed(db, issue.project_id, runID) ? "source_memory_suppressed"
    : page.has_more || page.skipped_invalid ? "evidence_summary_incomplete"
    : !validEvidence ? "no_valid_evidence"
    : Buffer.byteLength(summaryJSON) > REFLECTION_LIMITS.summaryBytes ? "input_budget_exceeded" : "";
  const now = new Date().toISOString();
  db.sqlite.run(`insert or ignore into pi_memory_reflections
    (id, project_id, issue_id, run_id, fingerprint, summary_json, status, reason, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [crypto.randomUUID(), issue.project_id, issueID, runID, fingerprint,
    reason === "input_budget_exceeded" ? "{}" : summaryJSON, reason ? "skipped" : "pending", reason, now, now]);
}

export function safelyRequestMemoryReflection(db: RunnerDatabase, issueID: number): void {
  try { requestMemoryReflection(db, issueID); }
  catch { console.warn("[pi-memory] reflection request deferred to delivery event recovery"); }
}

// 持久化游标补齐验收提交后、请求入库前的崩溃窗口。每轮最多读取 100 条交付事件。
export function reconcileMemoryReflectionEvents(db: RunnerDatabase): void {
  db.transaction(() => {
    const cursor = db.sqlite.query<{ event_id: number }, []>("select event_id from pi_memory_reflection_cursor where id=1").get()!.event_id;
    const events = db.sqlite.query<{ id: number; issue_id: number }, [number]>(`
      select id, issue_id from issue_events where id>? and type in
        ('issue.pi_acceptance_applied.v1', 'evidence.recorded.v1', 'issue.verification_human_evidence.v1',
         'handoff.prepared.v1', 'handoff.delivery_completed.v1') order by id limit 100
    `).all(cursor);
    for (const issueID of new Set(events.map(event => event.issue_id))) requestMemoryReflection(db, issueID);
    if (events.length) db.sqlite.run("update pi_memory_reflection_cursor set event_id=? where id=1", [events.at(-1)!.id]);
  }).immediate();
}

export function getMemoryReflection(db: RunnerDatabase, id: string): MemoryReflection | null {
  return db.sqlite.query<MemoryReflection, [string]>("select * from pi_memory_reflections where id=?").get(id);
}

export function claimMemoryReflection(db: RunnerDatabase, now = Date.now()): MemoryReflection | null {
  return db.transaction(() => {
    db.sqlite.run(`update pi_memory_reflections set status='failed', reason='crash_retry_exhausted',
      lease_token='', updated_at=? where status='running' and lease_until<=? and attempts>=2`, [new Date(now).toISOString(), now]);
    const row = db.sqlite.query<MemoryReflection, [number]>(`select r.* from pi_memory_reflections r
      join pi_memory_reflection_settings s on s.project_id=r.project_id and s.enabled=1
      where (r.status='pending' or (r.status='running' and r.lease_until<=?)) and r.attempts<2
      order by r.created_at, r.id limit 1`).get(now);
    if (!row) return null;
    db.sqlite.run(`update pi_memory_reflections set status='running', attempts=attempts+1,
      lease_token=?, lease_until=?, updated_at=? where id=?`,
    [crypto.randomUUID(), now + REFLECTION_LIMITS.leaseMs, new Date(now).toISOString(), row.id]);
    return getMemoryReflection(db, row.id);
  }).immediate();
}

export function requireReflectionLease(db: RunnerDatabase, lease: ReflectionLease, now = Date.now()): MemoryReflection {
  const row = getMemoryReflection(db, lease.id);
  if (!row || row.status !== "running" || row.lease_token !== lease.token || row.lease_until <= now
    || !memoryReflectionEnabled(db, row.project_id)) throw new Error("reflection lease is no longer valid");
  const issue = getIssue(db, row.issue_id);
  const summary = JSON.parse(row.summary_json) as ReflectionSummary;
  if (issue?.status !== (summary.outcome === "accepted" ? "done" : "failed")
    || `xw:run:issue_runs:${listIssueRuns(db, row.issue_id).at(-1)?.id}` !== row.run_id) {
    throw new Error("reflection terminal Work/Run has changed");
  }
  return row;
}

export function finishMemoryReflection(db: RunnerDatabase, lease: ReflectionLease,
  status: "completed" | "skipped" | "failed", reason: string, memoryID = ""): void {
  db.sqlite.run(`update pi_memory_reflections set status=?, reason=?, memory_id=?, lease_token='', lease_until=0,
    updated_at=? where id=? and status='running' and lease_token=?`,
  [status, redactSensitiveText(reason).slice(0, 1000), memoryID, new Date().toISOString(), lease.id, lease.token]);
}

export function failMemoryReflectionAttempt(db: RunnerDatabase, lease: ReflectionLease, reason: string): void {
  db.sqlite.run(`update pi_memory_reflections set status=case when attempts<2 then 'pending' else 'failed' end,
    reason=?, lease_token='', lease_until=0, updated_at=? where id=? and status='running' and lease_token=?`,
  [redactSensitiveText(reason).slice(0, 1000), new Date().toISOString(), lease.id, lease.token]);
}
