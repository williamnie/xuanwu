import type { AgentSession } from "../db/repositories/agentSessions.ts";
import type { IssueEvent } from "../db/repositories/issueEvents.ts";
import type { IssueRun } from "../db/repositories/issues.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import type { ProviderErrorSignal } from "./providerErrorParser.ts";
import type { SupervisorCandidate } from "./issueSupervisorContextSupport.ts";

export type ProviderOutageDiagnosisInput = {
  events: IssueEvent[];
  latestRun: IssueRun | null;
  now: Date;
  projectDeferredCount?: number;
  providerError: ProviderErrorSignal | null;
  session: AgentSession | null;
};

const OUTAGE_DIAGNOSES = new Set(["provider_timeout", "provider_transient_network_error"]);
const ISSUE_DEFERRED_THRESHOLD = 2;
const PROJECT_DEFERRED_THRESHOLD = 2;
const PROVIDER_DEFERRED_WINDOW_MS = 15 * 60 * 1_000;

export function providerDeferredWindowStart(now: Date): Date {
  return new Date(now.getTime() - PROVIDER_DEFERRED_WINDOW_MS);
}

export function providerDeferredCount(db: RunnerDatabase, input: {
  projectID: string;
  provider: string;
  since: Date;
}): number {
  const row = db.sqlite.query<{ count: number }, [string, string, string, string]>(`
    select count(distinct i.id) as count
    from issues i
    join issue_events e on e.issue_id=i.id
    left join (
      select ir.issue_id, ir.provider
      from issue_runs ir
      join (
        select issue_id, max(attempt) as attempt from issue_runs group by issue_id
      ) latest on latest.issue_id=ir.issue_id and latest.attempt=ir.attempt
    ) latest_run on latest_run.issue_id=i.id
    where i.project_id=? and i.status='in_progress'
      and e.type in ('issue.provider_deferred', 'issue.recovery_deferred')
      and e.created_at>=?
      and (?='' or coalesce(latest_run.provider, 'codex')=?)
  `).get(input.projectID, iso(input.since), clean(input.provider), clean(input.provider));
  return row?.count ?? 0;
}

export function providerOutageCandidate(input: ProviderOutageDiagnosisInput): SupervisorCandidate | null {
  if (!hardOutageProviderError(input.providerError)) return null;
  const evidence = outageEvidence(input);
  if (!evidence.hardOutage) return null;
  return {
    diagnosis_code: "provider_runtime_unavailable",
    evidence_refs: evidence.refs,
    reason: outageReason(evidence.reason)
  };
}

function hardOutageProviderError(providerError: ProviderErrorSignal | null): boolean {
  return OUTAGE_DIAGNOSES.has(clean(providerError?.diagnosis_code));
}

function outageEvidence(input: ProviderOutageDiagnosisInput): {
  hardOutage: boolean;
  reason: string;
  refs: string[];
} {
  const refs = ["provider_error"];
  // A startup timeout cannot have a recoverable session yet, but the Codex
  // transport stops the timed-out app-server process. Treat the first failure
  // as transient so PI can retry on a fresh process; escalate only after
  // repeated issue/project deferrals prove a broader outage.
  if (issueDeferredCount(input.events, input.now) >= ISSUE_DEFERRED_THRESHOLD) {
    return {
      hardOutage: true,
      reason: "issue has repeated provider recovery deferrals",
      refs: [...refs, "recent_events"]
    };
  }
  if ((input.projectDeferredCount ?? 0) >= PROJECT_DEFERRED_THRESHOLD) {
    return {
      hardOutage: true,
      reason: "project/provider has multiple in-progress provider deferrals",
      refs: [...refs, "project_provider_deferred_events"]
    };
  }
  return { hardOutage: false, reason: "", refs };
}

function issueDeferredCount(events: IssueEvent[], now: Date): number {
  const since = providerDeferredWindowStart(now).getTime();
  return events.filter((event) => DEFERRED_EVENT_TYPES.has(event.type) && eventMs(event) >= since).length;
}

const DEFERRED_EVENT_TYPES = new Set(["issue.provider_deferred", "issue.recovery_deferred"]);

function outageReason(reason: string): string {
  return redactAuditText(reason || "provider runtime is unavailable");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function eventMs(event: IssueEvent): number {
  const ms = Date.parse(event.created_at);
  return Number.isFinite(ms) ? ms : 0;
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
