import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueRuns } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { listStoredEvidence } from "../../db/repositories/evidence.ts";
import type { PiAcceptanceDecision } from "../../pi/issueAcceptance.ts";
import { COMPLETION_GIT_OBSERVATION_EVENT_TYPE, type CompletionCard } from "../acceptance/completionCard.ts";
import { redactEvidenceRecord, type EvidenceRecord } from "../evidence/contracts.ts";
import { readIssueRunGitWorkspaceBaseline, type CapturedGitWorkspaceBaseline } from "../evidence/runGitWorkspaceBaseline.ts";
import { runGit, withGitWorkspaceObservation } from "../run/gitWorkspaceObservation.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type { HandoffRecord } from "./contracts.ts";
import { redactSensitiveText } from "../../util/redact.ts";

export const ACCEPTED_DELIVERY_SOURCE = "pi-accepted-delivery";
type Scope = { baseline: string; final: string; paths: string[]; problems: string[] };

/** 仅投影已发生的事实；不重跑任务命令、执行 Git 写入或外部交付，也不重新判断 Work 是否完成。 */
export async function prepareAcceptedDelivery(db: RunnerDatabase, card: CompletionCard, decision: PiAcceptanceDecision) {
  const runs = listIssueRuns(db, card.issue.id);
  const workID = makeDomainID("work", "issues", String(card.issue.id));
  const runID = makeDomainID("run", "issue_runs", card.run.id);
  const runIDs = runs.slice(-256).map(run => makeDomainID("run", "issue_runs", run.id));
  const now = new Date(Math.max(Date.now(), Date.parse(card.git.observed_at) || 0,
    ...card.commands.items.map(command => Date.parse(command.observed_at) || 0))).toISOString();
  const sourceRef = `completion-card:${card.fingerprint}`;
  const scope = await deliveryScope(db, card, runs[0]?.id ?? card.run.id);
  const stored = listStoredEvidence(db, { work_id: workID, run_ids: runIDs, limit: 200 });
  if (stored.has_more || stored.skipped_invalid || runs.length > 256) scope.problems.push("执行或验证记录超出摘要上限，交付记录尚不完整。");
  if (card.commands.omitted) scope.problems.push("完成卡片省略了部分命令，不能据此声明所有验证已通过。");
  if (card.session.inspected && !card.session.latest_turn_matches_run) scope.problems.push("Provider Session 已有更新的 Turn，本凭证只记录当前 Run。");
  const baseEvidence = (suffix: string, kind: EvidenceRecord["kind"], status: EvidenceRecord["status"], summary: string): EvidenceRecord => ({
    schema_version: 1, id: makeDomainID("evidence", "issue_events", `accepted-${card.fingerprint}-${suffix}`),
    work_id: workID, run_id: runID, revision: 0, kind, status,
    created_at: now, observed_at: now, updated_at: now, completed_at: now,
    decisive_output: { summary, facts: {} }, artifact_refs: [{ kind: "report", ref: sourceRef }],
    provenance: { assertion_origin: "system_observation", source_kind: "git_repository", source_ref: sourceRef,
      audit_event_ref: `pi-acceptance:${card.fingerprint}`, producer: { kind: "runner", id: ACCEPTED_DELIVERY_SOURCE } },
    redaction: { status: "not_required", policy_ref: "evidence-redaction:v1", redacted_paths: [] },
  });
  const commands = card.commands.items.map((command, index) => {
    const passed = command.exit_code === 0 && command.status === "completed";
    const evidence = baseEvidence(`command-${index}`, "shell", passed ? "passed" : "failed",
      `命令观察：${command.command}`.slice(0, 4096));
    evidence.observed_at = new Date(command.observed_at).toISOString();
    evidence.decisive_output = {
      summary: evidence.decisive_output.summary, excerpt: command.output_excerpt, exit_code: command.exit_code,
      facts: { command: command.command, working_directory: command.cwd, duration_ms: command.duration_ms,
        observation_id: command.id, observation_source: command.source, output_is_excerpt: true },
    };
    evidence.provenance.assertion_origin = "tool_result";
    evidence.provenance.source_kind = "command_execution";
    evidence.provenance.source_ref = `${sourceRef}:command:${index + 1}`;
    return redactEvidenceRecord(evidence, "evidence-redaction:v1");
  });
  const git = baseEvidence("git", "git", scope.problems.length ? "blocked" : "passed",
    scope.problems.length ? "工作区观察存在归属或完整性缺口，详见交付风险。" : "已关联执行前后 Git 观察及本任务可归属的文件列表。");
  git.observed_at = new Date(card.git.observed_at).toISOString();
  git.decisive_output.facts = {
    base_revision: scope.baseline, head_revision: card.git.final_revision || null,
    final_snapshot_ref: scope.final, changed_path_count: scope.paths.length,
    changed_paths_json: JSON.stringify(scope.paths).length <= 8192 ? JSON.stringify(scope.paths) : null,
    working_tree_dirty: card.git.working_tree_dirty, observation_source: card.git.source,
    completion_card_ref: sourceRef,
  };
  const evidence = [...commands, redactEvidenceRecord(git, "evidence-redaction:v1")];
  const linked = [...stored.items.map(item => item.evidence), ...evidence];
  if (linked.some(item => item.status !== "passed")) scope.problems.push("保留了未通过或受阻的验证记录；PI 接受任务不等于这些检查已通过。");
  if (!scope.paths.length && scope.baseline !== scope.final) scope.problems.push("执行前后引用不同但没有可归属文件，保留草稿供核查。");
  const problems = [...new Set(scope.problems)];
  const handoff: HandoffRecord = {
    schema_version: 1, id: makeDomainID("handoff", "derived", `accepted-${card.fingerprint}`),
    work_id: workID, run_ids: runIDs, evidence_ids: [...new Set(linked.map(item => item.id))],
    revision: 0, status: problems.length ? "draft" : "ready", created_at: now, updated_at: now,
    summary: redactSensitiveText(`本凭证关联执行事实，仅记录本地产物，不声明推送、PR、部署或发布结果。\nPI 已接受任务「${card.issue.title}」。验收说明：${decision.rationale}`).slice(0, 4096),
    baseline_revision: scope.baseline, final_revision: scope.final, review_ref: `pi-acceptance:${card.fingerprint}`,
    changed_files: scope.paths, delivery: { mode: "local_changes", working_tree_ref: scope.final }, delivery_actions: [],
    risks: problems.map((summary, index) => ({ id: `observation_${index}`, severity: "medium", summary,
      mitigation: "核对关联的执行、完成卡片与验证事实；无需为补交付记录重新执行任务。", source_refs: [sourceRef] })),
    rollback: scope.paths.length ? {
      availability: "blocked", destructive: false, reason: "未生成回滚操作；请根据关联基线逐项审查，避免覆盖共享工作区。", refs: [scope.baseline],
    } : { availability: "not_required", destructive: false, reason: "本凭证没有执行工作区或外部写入。", refs: [] },
    review: { required: false, state: "not_applicable", reviewer_refs: [] },
  };
  if (scope.paths.length) handoff.risks.push({ id: "shared_workspace_rollback", severity: "low",
    summary: "自动交付记录不提供覆盖共享工作区的回滚操作。", mitigation: "按文件与基线审查后再决定回滚。", source_refs: [sourceRef] });
  return { evidence, handoff, recorded_at: now };
}

async function deliveryScope(db: RunnerDatabase, card: CompletionCard, firstRunID: string): Promise<Scope> {
  const unavailable = `completion-card:${card.fingerprint}:workspace-unavailable`;
  const scope: Scope = { baseline: unavailable, final: unavailable, paths: [], problems: [] };
  const baseline = readIssueRunGitWorkspaceBaseline(db, card.issue.id, firstRunID);
  const final = readFinalWorkspace(db, card);
  if (baseline) scope.baseline = workspaceRef(baseline);
  if (final) scope.final = workspaceRef(final);
  if (!baseline || !final) {
    scope.problems.push("缺少可信的执行前或执行后工作区快照，未将当前脏文件归属到本任务。");
    return scope;
  }
  const project = getProject(db, card.issue.project_id);
  let committed: string[] | null = [];
  if (baseline.base_revision !== final.base_revision) {
    try {
      committed = project ? await withGitWorkspaceObservation(project.cwd, async (cwd, deadline) => {
        const result = await runGit(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z",
          baseline.base_revision, final.base_revision, "--"], deadline);
        return result ? result.stdout.toString().split("\0").filter(Boolean) : null;
      }) : null;
    } catch { committed = null; }
  }
  if (!committed) scope.problems.push("无法读取执行前后提交的文件差异，已保留未知状态。");
  const before = new Map(baseline.entries.map(entry => [entry.path, entry]));
  const after = new Map(final.entries.map(entry => [entry.path, entry]));
  const paths = new Set<string>();
  const uncertain = new Set<string>();
  for (const path of committed ?? []) {
    if (before.has(path)) uncertain.add(path); else paths.add(path);
  }
  for (const entry of final.entries) {
    const previous = before.get(entry.path);
    if (!previous) paths.add(entry.path);
    else if (previous.content_oid !== entry.content_oid || previous.status !== entry.status) uncertain.add(entry.path);
  }
  for (const path of before.keys()) if (!after.has(path)) uncertain.add(path);
  for (const path of uncertain) paths.delete(path);
  if (uncertain.size) scope.problems.push(`有 ${uncertain.size} 个执行前已存在的改动路径发生变化，已排除其归属，需人工核查。`);
  scope.paths = [...paths].sort().slice(0, 4096);
  if (paths.size > 4096) scope.problems.push("可归属文件超过交付摘要上限，文件列表不完整。");
  return scope;
}

function workspaceRef(snapshot: CapturedGitWorkspaceBaseline): string {
  return `git:${snapshot.base_revision}:workspace:${snapshot.snapshot_sha256}`;
}

// 完整快照留在事件账本；Completion Card / LLM 上下文只携带引用。
function readFinalWorkspace(db: RunnerDatabase, card: CompletionCard): CapturedGitWorkspaceBaseline | null {
  if (!card.git.workspace_snapshot_ref) return null;
  const rows = db.sqlite.query<{ payload: string }, [number, string, string]>(`
    select payload from issue_events where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload, '$.observation.run_id')=? order by id desc limit 20
  `).all(card.issue.id, COMPLETION_GIT_OBSERVATION_EVENT_TYPE, card.run.id);
  for (const row of rows) {
    try {
      const value = JSON.parse(row.payload).observation?.workspace_snapshot;
      if (`run-git-snapshot:${card.run.id}:${value?.snapshot_sha256}` !== card.git.workspace_snapshot_ref) continue;
      const valid = validWorkspaceSnapshot(value, card.git.final_revision);
      if (valid) return valid;
    } catch { /* 无效或缺失的旧观察保持未知。 */ }
  }
  return null;
}

function validWorkspaceSnapshot(value: CapturedGitWorkspaceBaseline | undefined, head: string): CapturedGitWorkspaceBaseline | null {
  if (!value || value.base_revision !== head || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head) || !Array.isArray(value.entries)) return null;
  if (value.entries.some(entry => !entry || typeof entry.path !== "string" || !entry.path || entry.path.length > 4096
    || typeof entry.status !== "string" || typeof entry.content_oid !== "string")) return null;
  const hash = createHash("sha256").update(`${JSON.stringify(value.entries)}\n`).digest("hex");
  return hash === value.snapshot_sha256 ? value : null;
}
