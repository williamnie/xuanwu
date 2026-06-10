import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiAgent,
  listPiAgents,
  listPiActions,
  listPiDelegations,
  listPiHeartbeatRuns,
  listPiMemoryItems,
  listIssueSupervisorEvents,
  listProjectPiSettings,
  type PiMemoryItem,
  type PiHeartbeatRun
} from "../db/repositories/pi.ts";
import type { Router } from "./router.ts";
import { json } from "./errors.ts";
import { piRuntimePromptSummary } from "./piRuntimePrompt.ts";

type PiCommandCenterContext = { database: RunnerDatabase };

export function registerPiCommandCenterRoutes(router: Router, context: PiCommandCenterContext): void {
  router.get("/api/pi/command-center", () => json(buildPiCommandCenter(context.database)));
}

function buildPiCommandCenter(db: RunnerDatabase) {
  const settings = listProjectPiSettings(db);
  const activeDelegations = listPiDelegations(db, { status: "active" });
  const pendingApprovals = listPiActions(db, { status: "pending" });
  const latestRun = listPiHeartbeatRuns(db).at(0) ?? null;
  const supervisorEvents = listIssueSupervisorEvents(db);
  const memoryItems = listPiMemoryItems(db);

  return {
    generated_at: new Date().toISOString(),
    mode: commandMode(settings, activeDelegations.length),
    overview: {
      active_delegations: activeDelegations.length,
      autonomous_projects: settings.filter((item) => item.auto_manage === 1).length,
      pending_approvals: pendingApprovals.length
    },
    heartbeat: heartbeatSummary(latestRun),
    memory: memorySummary(memoryItems),
    prompt_debug: promptDebug(db, settings),
    supervisor: supervisorSummary(supervisorEvents)
  };
}

function memorySummary(items: PiMemoryItem[]) {
  const active = items.filter((item) => item.disabled === 0);
  const candidates = items.filter((item) => item.disabled === 1);
  return {
    active_count: active.length,
    candidate_count: candidates.length,
    recent_candidate_sources: candidates.slice(0, 5).map(memoryCandidateSource),
    source_policy: {
      chat: "enabled_candidate_only",
      manager_cycle: "enabled_candidate_only",
      supervisor: "enabled_candidate_only",
      failure_pattern_generator: "enabled_candidate_only",
      promote: "manual_review_required"
    }
  };
}

function memoryCandidateSource(item: PiMemoryItem) {
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    scope_id: item.scope_id,
    source_id: item.source_id,
    source_type: item.source_type,
    updated_at: item.updated_at
  };
}

function promptDebug(db: RunnerDatabase, settings: ReturnType<typeof listProjectPiSettings>) {
  const agentID = settings.find((item) => item.auto_manage === 1)?.pi_agent_id ||
    settings[0]?.pi_agent_id ||
    listPiAgents(db).find((agent) => agent.enabled === 1)?.id ||
    "";
  const agent = agentID ? getPiAgent(db, agentID) : null;
  return agent ? { agent_id: agent.id, runtime_prompt_summary: piRuntimePromptSummary(agent) } : null;
}

function supervisorSummary(events: ReturnType<typeof listIssueSupervisorEvents>) {
  return {
    latest_event: events.at(-1) ?? null,
    needs_user_escalations: events.filter((event) => event.action_type === "needs_user.escalate" || event.decision === "needs_user").length,
    rate_limit_waits: events.filter((event) => event.action_type === "issue.retry_after" || event.retry_after_at !== "").length,
    recovery_actions: events.filter((event) => event.event_type === "action").length
  };
}

function commandMode(settings: Array<{ auto_manage: number }>, activeDelegations: number): string {
  if (settings.some((item) => item.auto_manage === 1) || activeDelegations > 0) return "delegated";
  if (settings.length > 0) return "attended";
  return "manual";
}

function heartbeatSummary(latestRun: PiHeartbeatRun | null) {
  return {
    latest_run: latestRun,
    status: latestRun?.status || "idle"
  };
}
