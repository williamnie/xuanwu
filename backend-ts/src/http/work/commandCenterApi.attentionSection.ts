import { attachWorkSchedules, type ScheduledWork } from "./workSchedule.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { countStoredHandoffs, listStoredHandoffs, type StoredHandoffRecord } from "../../db/repositories/handoffs.ts";
import { listPersistedAttention } from "../../domain/attention/persistence.ts";
import type { AttentionRecord } from "../../domain/attention/contracts.ts";
import { listLatestRunsForWorkIDs, type RunView } from "../../db/repositories/runs.ts";
import { countIssueBackedWorks, listIssueBackedWorks, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { readIssueReadiness } from "../../domain/readiness/contracts.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { handoffHref } from "../../notifications/handoffNotifier.ts";
import { guardianOperationsSnapshot, latestGuardianOperationsReport } from "../../pi/guardian/guardianOperationsDailyReport.ts";
import type { SectionInput, CommandCenterSectionPayload } from "./commandCenterApi.model.ts";
import { attentionIsVisible, ACTIVE_WORK_STATUSES, RECENT_HANDOFF_STATUSES } from "./commandCenterApi.piActionAttentionDetails.ts";
import { attentionHandling, freshness, attentionSummary, attentionDetails, boundedText } from "./commandCenterApi.attentionDetails.ts";

export function attentionSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const projected = listPersistedAttention(db, { actionLimit: input.limit, now: input.now })
    .filter((item) => attentionIsVisible(item, input.now));
  const piHandling = projected.filter((item) => attentionHandling(db, item, input.now) === "pi_handling");
  const userItems = projected.filter((item) => attentionHandling(db, item, input.now) === "user_action_required");
  const historical = projected.filter((item) => attentionHandling(db, item, input.now) === "historical");
  const items = userItems.slice(0, input.limit);
  const operations = guardianOperationsSnapshot(db, { now: input.now });
  return {
    counts: {
      pi_handling: piHandling.length,
      returned: items.length,
      total: userItems.length,
      resolved_24h: operations.summary.alerts_recovered,
      source_total: userItems.length + piHandling.length,
      historical_hidden: historical.length
    },
    // This section is a request-time read of current authorities. An unchanged
    // queue is not stale data; transport/read failures are reported by the
    // section error envelope instead.
    freshness: freshness(input.now, [input.now.toISOString()], 60),
    items: items.map((item) => attentionSummary(db, item, input.now)),
    operations: {
      active: piHandling.slice(0, 5).map((item) => attentionSummary(db, item, input.now)),
      latest_report: latestGuardianOperationsReport(db),
      summary: operations.summary,
      window: operations.window
    },
    recent_history: [
      ...operations.incidents.filter((item) => item.historical === true),
      ...historical.map((item) => historicalAttentionSummary(db, item, input.now))
    ].sort((left, right) => String(right.last_seen_at).localeCompare(String(left.last_seen_at))).slice(0, 5),
    links: { collection: "/api/command-center/summary?sections=attention" }
  };
}

export function activeWorkSection(db: RunnerDatabase, input: SectionInput, context: ReadApiContext): CommandCenterSectionPayload {
  const filter = {
    limit: input.limit,
    offset: 0,
    sort: "updated_at" as const,
    sortOrder: "desc" as const,
    statuses: ACTIVE_WORK_STATUSES
  };
  const works = attachWorkSchedules(context, listIssueBackedWorks(db, filter));
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
    items: works.map((work) => activeWorkSummary(db, work, runByWorkID.get(work.id))),
    links: { collection: "/api/works", runs: "/api/runs" }
  };
}

export function recentDeliveriesSection(db: RunnerDatabase, input: SectionInput): CommandCenterSectionPayload {
  const filter = { statuses: RECENT_HANDOFF_STATUSES };
  const page = listStoredHandoffs(db, { ...filter, limit: input.limit });
  return {
    counts: {
      returned: page.items.length,
      skipped_invalid: page.skipped_invalid,
      total: countStoredHandoffs(db, filter)
    },
    freshness: freshness(input.now, page.items.map((record) => record.handoff.updated_at), 5 * 60),
    items: page.items.map((record) => handoffSummary(db, record)),
    links: { collection: "/api/handoffs" }
  };
}

export function historicalAttentionSummary(
  db: RunnerDatabase,
  item: AttentionRecord,
  now: Date
): Record<string, unknown> {
  const details = attentionDetails(db, item, now);
  return {
    alert_id: item.id,
    historical: true,
    last_seen_at: details.last_seen_at,
    location: details.location,
    state_label: details.state_label,
    title: details.title
  };
}

export function activeWorkSummary(db: RunnerDatabase, work: ScheduledWork, run: RunView | undefined): Record<string, unknown> {
  const issueID = workIDToIssueID(work.id);
  return {
    id: work.id,
    ...(work.schedule ? { schedule: work.schedule } : {}),
    latest_run: run ? runSummary(run) : null,
    links: {
      issue: `/api/issues/${issueID}`,
      project: `/api/projects/${encodeURIComponent(work.owner.project_id)}`,
      runs: `/api/runs?work_id=${encodeURIComponent(work.id)}`,
      self: `/api/works/${encodeURIComponent(work.id)}`
    },
    project_id: work.owner.project_id,
    readiness: readIssueReadiness(db, issueID),
    revision: work.revision,
    status: work.status,
    title: work.title,
    updated_at: work.updated_at
  };
}

export function runSummary(run: RunView): Record<string, unknown> {
  return {
    ended_at: run.ended_at,
    id: run.id,
    phase: run.progress.provider_phase,
    progress: {
      latest: run.progress.latest,
      stalled: run.progress.stalled,
      updated_at: run.progress.updated_at
    },
    provider: run.provider,
    started_at: run.started_at,
    status: run.status,
    updated_at: run.updated_at
  };
}

export function handoffSummary(db: RunnerDatabase, record: StoredHandoffRecord): Record<string, unknown> {
  const handoff = record.handoff;
  const issue = getIssue(db, record.issue_id);
  return {
    delivery: handoff.delivery,
    evidence_count: handoff.evidence_ids.length,
    id: handoff.id,
    issue: issue ? {
      id: issue.id,
      status: issue.status,
      title: issue.title
    } : null,
    links: {
      evidence: `/api/evidence?work_id=${encodeURIComponent(handoff.work_id)}`,
      self: `/api/handoffs/${encodeURIComponent(handoff.id)}`,
      view: handoffHref(handoff.id, handoff.work_id),
      work: `/api/works/${encodeURIComponent(handoff.work_id)}`
    },
    project_id: record.project_id,
    review: handoff.review,
    revision: handoff.revision,
    risk_count: handoff.risks.length,
    status: handoff.status,
    summary: boundedText(handoff.summary),
    updated_at: handoff.updated_at,
    work_id: handoff.work_id
  };
}
