import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";
import {
  assertIssueDependencyDeclarationMatches,
  normalizeIssueDependencyDeclaration,
  parseIssueDependencyDeclaration
} from "../../domain/work/issueDependencyDeclaration.ts";
import {
  type UpdateIssueInput,
  normalizeIssuePatch,
  issueToPatchShape,
  validateIssuePatch,
  PATCH_FIELDS,
  mustGetIssue
} from "./issueUpdatePatch.ts";
import {
  readIssueDependencyState,
  sameIssueDependencies,
  assertUnstartedPlanningUpdate,
  validateIssueDependencies,
  syncIssueDependencies,
  syncPiRunGroupItems
} from "./issueUpdateDependencies.ts";
import { closeOpenIssueRun } from "./issueUpdateRuns.ts";

export function updateIssue(db: RunnerDatabase, id: number, input: UpdateIssueInput): Issue {
  const write = db.transaction(() => {
    const current = getIssue(db, id);
    if (!current) throw new ProjectNotFoundError();
    const patch = normalizeIssuePatch(input);
    const next = { ...issueToPatchShape(current), ...patch };
    validateIssuePatch(db, current, patch, next);
    const dependencyRequested = Object.hasOwn(input, "depends_on_issue_ids");
    const dependencyState = readIssueDependencyState(db, current.id);
    const dependencyIssueIDs = dependencyRequested
      ? normalizeIssueDependencyDeclaration(input.depends_on_issue_ids, next.description).issue_ids
      : dependencyState.issue_ids;
    if (Object.hasOwn(patch, "description") || dependencyRequested) {
      assertIssueDependencyDeclarationMatches(next.description, dependencyIssueIDs);
    }
    if (Object.hasOwn(patch, "description") && !dependencyRequested
      && parseIssueDependencyDeclaration(next.description).present
      && !sameIssueDependencies(dependencyState, dependencyIssueIDs)) {
      throw new Error("现有结构化依赖快照与硬依赖边不一致；请同时提供 depends_on_issue_ids 以原子修复");
    }
    const dependencyNeedsSync = dependencyRequested && !sameIssueDependencies(dependencyState, dependencyIssueIDs);
    const changedFields = PATCH_FIELDS.filter((field) => (
      Object.hasOwn(patch, field) && next[field] !== issueToPatchShape(current)[field]
    ));
    const planningFields = changedFields.filter((field) => field === "title" || field === "description");
    const planningRequested = Object.hasOwn(patch, "title")
      || Object.hasOwn(patch, "description")
      || dependencyRequested;
    if (planningFields.length > 0 || dependencyNeedsSync) {
      assertUnstartedPlanningUpdate(db, current);
    }
    if (dependencyRequested) validateIssueDependencies(db, current.id, next.project_id, dependencyIssueIDs);
    if (planningRequested && changedFields.length === 0 && !dependencyNeedsSync) return current;
    const timestamp = issueTimestamp();
    db.sqlite.run(`update issues set project_id=?, title=?, description=?, status=?, priority=?,
      required_skill_intents_json=?, recommended_skill_intents_json=?,
      required_mcp_capabilities_json=?, recommended_mcp_capabilities_json=?,
      agent_profile_id=?, service_tier=?, source_session_id=?, source_turn_id=?, source_excerpt=?,
      codex_thread_id=?, codex_turn_id=?, auto_retry_next_at=?, auto_retry_reason=?,
      error=?, issue_log_mode=?,
      dependency_issue_ids_json=case when ? then ? else dependency_issue_ids_json end,
      dependency_declaration_error=case when ? then '' else dependency_declaration_error end,
      updated_at=? where id=?`,
      [next.project_id, next.title, next.description, next.status, next.priority,
        next.required_skill_intents, next.recommended_skill_intents,
        next.required_mcp_capabilities, next.recommended_mcp_capabilities,
        next.agent_profile_id, next.service_tier, next.source_session_id, next.source_turn_id,
        next.source_excerpt, next.codex_thread_id, next.codex_turn_id,
        next.auto_retry_next_at, next.auto_retry_reason, next.error, next.issue_log_mode,
        dependencyNeedsSync ? 1 : 0, JSON.stringify(dependencyIssueIDs), dependencyNeedsSync ? 1 : 0,
        timestamp, current.id]);
    if (dependencyNeedsSync) syncIssueDependencies(db, next.project_id, current.id, dependencyIssueIDs, timestamp);
    if (Object.hasOwn(patch, "status")) {
      if (current.status !== next.status) {
        if (next.status !== "in_progress") closeOpenIssueRun(db, next, timestamp);
        db.sqlite.run(
          `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
          [current.id, "issue.status_changed", JSON.stringify({ status: next.status }), timestamp]
        );
      }
      syncPiRunGroupItems(db, next, timestamp);
    }
    const metadataFields = [
      ...planningFields,
      ...(dependencyNeedsSync ? ["depends_on_issue_ids"] : [])
    ];
    if (metadataFields.length > 0) {
      db.sqlite.run(
        `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
        [current.id, "issue.planning_metadata_updated.v1", JSON.stringify({
          contract: "unstarted-issue-planning-update-v1",
          fields: metadataFields,
          ...(dependencyNeedsSync ? { depends_on_issue_ids: dependencyIssueIDs } : {})
        }), timestamp]
      );
    }
    return mustGetIssue(db, current.id);
  });
  return write.immediate();
}
