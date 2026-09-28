import type { RunnerDatabase } from "../db/database.ts";
import { getStoredEvidence } from "../db/repositories/evidence.ts";
import { getStoredHandoff, HANDOFF_RECORD_EVENT_TYPES } from "../db/repositories/handoffs.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getRun } from "../db/repositories/runs.ts";
import { canSatisfyEvidenceGate, type RunID } from "../domain/evidence/contracts.ts";
import type { MemoryExperience } from "./memoryExperience.ts";

// 此处只核实持久化事实和归属。经验是否可复用、根因与证据的语义关系仍由 Pi 判断。
export function memoryEvidenceRejection(
  db: RunnerDatabase,
  projectID: string,
  experience: MemoryExperience,
  evidenceRef?: string
): string | undefined {
  const { work_id: workID, run_id: runID } = experience.source;
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  const issueID = match ? Number(match[1]) : 0;
  const issue = Number.isSafeInteger(issueID) && issueID > 0 ? getIssue(db, issueID) : null;
  if (!issue || issue.project_id !== projectID) return "experience Work is missing or belongs to another project";
  const run = getRun(db, runID as RunID);
  if (!run || run.work_id !== workID || run.project_id !== projectID) {
    return "experience Run is missing or belongs to another Work/project";
  }

  const diagnosisOnly = experience.outcome === "diagnosis_only";
  if (diagnosisOnly && (issue.status !== "failed" || !run.ended_at)) {
    return "diagnosis-only experience requires a terminal failed Work";
  }
  const evidenceError = (id: string, requirePassed: boolean): string | undefined => {
    const stored = getStoredEvidence(db, id);
    if (!stored || stored.project_id !== projectID || stored.issue_id !== issueID ||
      stored.evidence.work_id !== workID || stored.evidence.run_id !== runID) {
      return "experience Evidence is missing or belongs to another project/Work/Run";
    }
    // 已纠正的旧证据不能继续支撑新经验，即使旧记录仍然显示 passed。
    const superseded = db.sqlite.query<{ id: number }, [string]>(`
      select id from issue_events where type in ('evidence.recorded.v1', 'issue.verification_human_evidence.v1')
        and json_valid(payload) and json_extract(payload, '$.evidence.supersedes_id')=? limit 1
    `).get(id);
    if (superseded) return "experience Evidence has been superseded";
    if (["agent_claim", "legacy_import"].includes(stored.evidence.provenance.assertion_origin)) {
      return "experience Evidence must have trusted provenance";
    }
    if (diagnosisOnly && !["passed", "failed"].includes(stored.evidence.status)) return "diagnosis requires terminal Evidence";
    if (requirePassed && (!canSatisfyEvidenceGate(stored.evidence) ||
      (stored.evidence.decisive_output.exit_code !== undefined && stored.evidence.decisive_output.exit_code !== 0))) {
      return "experience verification requires trusted passed Evidence";
    }
    return undefined;
  };

  const referenceError = (reference: string): string | undefined => {
    const separator = reference.indexOf(":");
    const type = reference.slice(0, separator);
    const id = reference.slice(separator + 1);
    if (type === "work" && id === workID) return undefined;
    if (type === "run" && id === runID) return undefined;
    if (type === "evidence") return evidenceError(id, false);
    if (type === "handoff") {
      const stored = getStoredHandoff(db, id);
      if (!stored || stored.project_id !== projectID || stored.issue_id !== issueID ||
        stored.handoff.work_id !== workID || stored.handoff.run_ids.length !== 1 || stored.handoff.run_ids[0] !== runID) {
        return "experience Handoff is missing or belongs to another project/Work/Run";
      }
      if (!["ready", "delivered"].includes(stored.handoff.status)) return "experience Handoff is not ready or delivered";
      if (stored.handoff.evidence_ids.length === 0) return "experience Handoff has no Evidence";
      // 不信任 Handoff 的摘要；每个底层 Evidence 都重新读取并验证。
      for (const evidenceID of stored.handoff.evidence_ids) {
        const reason = evidenceError(evidenceID, true);
        if (reason) return reason;
      }
      return undefined;
    }
    if (type === "issue_event" && /^[1-9][0-9]*$/.test(id)) {
      const event = db.sqlite.query<{ issue_id: number; type: string; payload: string }, [string]>(
        "select issue_id, type, payload from issue_events where id=?"
      ).get(id);
      if (!event || event.issue_id !== issueID) return "experience source event is missing or belongs to another Work";
      try {
        const payload = JSON.parse(event.payload);
        if (["evidence.recorded.v1", "issue.verification_human_evidence.v1"].includes(event.type) &&
          typeof payload?.evidence?.id === "string") return evidenceError(payload.evidence.id, false);
        if ((HANDOFF_RECORD_EVENT_TYPES as readonly string[]).includes(event.type) && typeof payload?.handoff?.id === "string") {
          return referenceError(`handoff:${payload.handoff.id}`);
        }
      } catch { /* 无法解析或无法关联 Run 的事件不能作为经验来源。 */ }
      return "experience source event must resolve to persisted Evidence or Handoff";
    }
    return "experience reference is unsupported or belongs to another Work/Run";
  };

  for (const reference of [...experience.source.refs, ...(evidenceRef ? [evidenceRef.trim()] : [])]) {
    const reason = referenceError(reference);
    if (reason) return reason;
  }
  for (const reference of experience.verification.evidence_refs) {
    if (!reference.startsWith("evidence:")) return "experience verification requires Evidence references";
    const reason = evidenceError(reference.slice("evidence:".length), !diagnosisOnly);
    if (reason) return reason;
  }
  return undefined;
}
