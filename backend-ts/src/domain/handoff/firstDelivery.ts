import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { listStoredEvidence, recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import { getStoredHandoff } from "../../db/repositories/handoffs.ts";
import { createGitEvidenceCollector, type GitEvidenceCollector } from "../evidence/gitCollector.ts";
import { recordHandoffDelivery } from "../../notifications/handoffNotifier.ts";
import type { EventBus } from "../../events/bus.ts";
import type { HandoffRecord } from "./contracts.ts";

const FIRST_DELIVERY_TITLE = "玄武首次交付：只读项目体检";
export async function completeFirstDelivery(db: RunnerDatabase, issueID: number, options: {
  bus?: EventBus; collector?: GitEvidenceCollector;
} = {}) {
  const issue = getIssue(db, issueID);
  const createdByGuide = db.sqlite.query<{ count: number }, [number]>(`
    select count(*) as count from issue_events where issue_id=? and type='issue.created'
      and json_valid(payload) and json_extract(payload, '$.actor.id')='first-delivery-guide'
  `).get(issueID)?.count;
  if (!issue || issue.title !== FIRST_DELIVERY_TITLE || !createdByGuide) throw new Error("只能检查由首启引导创建的示例任务");
  if (issue.status !== "done") throw new Error("示例任务尚未完成，请先处理执行结果");
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run?.ended_at || !["succeeded", "done"].includes(run.status)) throw new Error("缺少已成功结束的执行记录");
  const workID = `xw:work:issues:${issueID}` as const;
  const runID = `xw:run:issue_runs:${run.id}` as const;
  const handoffID = `xw:handoff:derived:first-delivery-${issueID}-${encodeURIComponent(run.id)}` as const;
  const existing = getStoredHandoff(db, handoffID);
  if (existing) return { created: false, handoff: existing.handoff };
  const evidencePage = listStoredEvidence(db, { work_id: workID, run_ids: [runID], limit: 100 });
  if (evidencePage.has_more || evidencePage.skipped_invalid) throw new Error("验证记录不完整，请先检查执行详情");
  const evidence = evidencePage.items.map(item => item.evidence).filter(item => item.kind !== "git");
  if (evidence.some(item => item.status !== "passed")) throw new Error("本次执行仍有未通过的验证，请处理后重试");
  if (!evidence.length) throw new Error("本次执行缺少已通过的验证记录，请在下方让玄武补齐验证后重试");
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error("示例任务所属项目不存在");
  const now = new Date().toISOString();
  const git = await (options.collector || createGitEvidenceCollector()).collect({
    repository_path: project.cwd,
    untracked_policy: "exclude",
    context: {
      evidence_id: `xw:evidence:git:first-delivery-${issueID}-${encodeURIComponent(run.id)}`,
      work_id: workID, run_id: runID, producer: { kind: "system", id: "first-delivery-check" },
      audit_event_ref: `first-delivery-check:${issueID}:${run.id}`, collected_at: now,
      source_ref: `project:${project.id}`,
    },
  });
  const snapshot = String(git.decisive_output.facts.snapshot_sha256 || "");
  if (git.status !== "passed" || !snapshot) throw new Error("无法取得有效的工作区快照");
  const reference = `git-snapshot:${snapshot}`;
  const handoff: HandoffRecord = {
    schema_version: 1, id: handoffID, work_id: workID, run_ids: [runID],
    evidence_ids: [...evidence.map(item => item.id), git.id], revision: 0, status: "ready",
    summary: "已完成首次只读项目体检，验证记录和当前工作区快照已关联；本凭证不声明任何代码改动。",
    created_at: now, updated_at: now, baseline_revision: reference, final_revision: reference,
    review_ref: `first-delivery-check:${issueID}:${run.id}`, changed_files: [],
    delivery: { mode: "local_changes", working_tree_ref: reference }, delivery_actions: [],
    risks: [], rollback: { availability: "not_required", destructive: false, reason: "只读检查无需回滚", refs: [] },
    review: { required: false, state: "not_applicable", reviewer_refs: [] },
  };
  return db.transaction(() => {
    const current = getIssue(db, issueID);
    const latest = listIssueRuns(db, issueID).at(-1);
    if (current?.status !== "done" || current.updated_at !== issue.updated_at || latest?.id !== run.id || !latest.ended_at) {
      throw new Error("任务状态已变化，请刷新后重新检查");
    }
    const replay = getStoredHandoff(db, handoffID);
    if (replay) return { created: false, handoff: replay.handoff };
    recordEvidenceRecords(db, issueID, [git], { recorded_at: now, source: "first-delivery-check" });
    const result = recordHandoffDelivery({ database: db, bus: options.bus, issue_id: issueID, handoff,
      recorded_at: now, source: "first-delivery-check" });
    return { created: result.created, handoff: result.record.handoff };
  }).immediate();
}
