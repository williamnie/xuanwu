import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { findExternalEventByDedupe, upsertExternalEvent, type ExternalEventRecord } from "../../db/repositories/externalEvents.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import {
  getTrackerIssueLink,
  getTrackerProjectMapping,
  recordTrackerSyncAudit,
  saveTrackerCursor,
  trackerIssueProvider,
  trackerScope,
  upsertTrackerIssueLink,
  type TrackerIssueProvider
} from "../../db/repositories/trackerIssueSync.ts";
import { CHANNEL_CONNECTOR_CONTRACT_VERSION, validateInboundEnvelope, type ConnectorManifest, type InboundEnvelope } from "../channelConnectorContracts.ts";

type JsonObject = Record<string, unknown>;
export type TrackerIssueEvent = {
  actor: string;
  cursor?: { position: string; scope: string };
  description: string;
  event_name: string;
  external_id: string;
  external_status: string;
  external_updated_at: string;
  payload: JsonObject;
  provider: TrackerIssueProvider;
  scope: string;
  title: string;
  url: string;
};

export type TrackerIssuePollResult = { cursor?: { position: string; scope: string }; events: TrackerIssueEvent[] };
export interface TrackerIssueAdapter {
  readonly provider_id: TrackerIssueProvider;
  poll(cursor?: { position: string; scope: string }): Promise<TrackerIssuePollResult>;
}

export function trackerIssueConnectorManifest(provider: TrackerIssueProvider): ConnectorManifest {
  return {
    auth_refs: [], capabilities: [{ id: "issue", kind: "inbound", requires_authorization: true }],
    contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
    display_name: `${provider} Issue Tracker`, id: `${provider}-issues`, kind: "event_source"
  };
}

export function syncTrackerIssueEvent(db: RunnerDatabase, input: TrackerIssueEvent, trigger: "poll" | "webhook" = "webhook"): {
  conflict: boolean; event: ExternalEventRecord; issue_id?: number; linked: boolean; replayed: boolean;
} {
  const event = normalizeTrackerIssueEvent(input);
  const correlationID = `${event.provider}:${event.external_id}:${event.external_updated_at}`;
  const dedupeKey = `${event.provider}:${event.external_id}:${event.external_updated_at}`;
  const prior = findExternalEventByDedupe(db, event.provider, dedupeKey);
  const payloadHash = createHash("sha256").update(JSON.stringify(event.payload)).digest("hex");
  if (prior && String(prior.summary.raw_payload_sha256 ?? "") !== payloadHash) throw new Error("tracker_event_dedupe_conflict");
  if (prior) {
    const link = getTrackerIssueLink(db, event.provider, event.external_id);
    if (event.cursor) saveTrackerCursor(db, { provider: event.provider, scope: event.cursor.scope, position: event.cursor.position });
    return { conflict: false, event: prior, issue_id: link?.issue_id, linked: link !== null, replayed: true };
  }
  const write = db.transaction(() => {
    const link = getTrackerIssueLink(db, event.provider, event.external_id);
    const mapping = getTrackerProjectMapping(db, event.provider, event.scope);
    const projectID = link?.project_id ?? mapping?.project_id ?? "";
    const stored = upsertExternalEvent(db, {
      actor: event.actor, content: `${event.scope}: ${event.title}`.slice(0, 4096), dedupe_key: dedupeKey,
      event_type: "issue", external_id: event.external_id, occurred_at: event.external_updated_at,
      normalized_message: { external_status: event.external_status, scope: event.scope, title: event.title, url: event.url },
      project_hint: event.scope, project_id: projectID, provider: event.provider, raw_json: event.payload,
      source: event.provider, status: projectID ? "linked" : "attention",
      summary: { raw_payload_sha256: payloadHash, sync_trigger: trigger }, trust_level: "authenticated"
    });
    if (!projectID) {
      recordTrackerSyncAudit(db, { action: "unmapped", correlation_id: correlationID, external_id: event.external_id, provider: event.provider });
      return { conflict: false, event: stored, linked: false };
    }
    if (!link) {
      const issue = createIssue(db, {
        description: event.description, project_id: projectID, source_excerpt: event.url,
        source_session_id: `${event.provider}:${event.external_id}`, source_turn_id: correlationID,
        status: issueStatusFor(event.provider, event.external_status), title: event.title
      }, { createdEventPayload: { external_id: event.external_id, provider: event.provider, source: "tracker_intake" } });
      const savedLink = upsertTrackerIssueLink(db, {
        external_id: event.external_id, issue_id: issue.id, last_external_updated_at: event.external_updated_at,
        last_synced_issue_updated_at: issue.updated_at, provider: event.provider
      });
      createExternalLink(db, { external_event_id: stored.id, external_type: "tracker_issue", issue_id: issue.id, project_id: projectID, relationship: "intake", source: event.provider });
      recordTrackerSyncAudit(db, { action: "intake_created", correlation_id: correlationID, external_id: event.external_id, issue_id: issue.id, project_id: savedLink.project_id, provider: event.provider });
      return { conflict: false, event: stored, issue_id: issue.id, linked: true };
    }
    const outcome = applyMappedStatus(db, link, event, correlationID);
    createExternalLink(db, { external_event_id: stored.id, external_type: "tracker_issue", issue_id: link.issue_id, project_id: link.project_id, relationship: outcome.action, source: event.provider });
    return { conflict: outcome.conflict, event: stored, issue_id: link.issue_id, linked: true };
  });
  const result = write.immediate();
  if (event.cursor) saveTrackerCursor(db, { provider: event.provider, scope: event.cursor.scope, position: event.cursor.position });
  return { ...result, replayed: false };
}

export async function pollTrackerIssues(db: RunnerDatabase, adapter: TrackerIssueAdapter, cursor?: { position: string; scope: string }) {
  const polled = await adapter.poll(cursor);
  const results = polled.events.map((event) => syncTrackerIssueEvent(db, event, "poll"));
  if (polled.cursor) saveTrackerCursor(db, { provider: adapter.provider_id, scope: polled.cursor.scope, position: polled.cursor.position });
  return { results, summary: { conflicts: results.filter((item) => item.conflict).length, replayed: results.filter((item) => item.replayed).length, synced: results.length } };
}

function applyMappedStatus(db: RunnerDatabase, link: ReturnType<typeof getTrackerIssueLink> & {}, event: TrackerIssueEvent, correlationID: string): { action: string; conflict: boolean } {
  const issue = getIssue(db, link.issue_id);
  if (!issue) throw new Error("linked issue not found");
  if (event.external_updated_at <= link.last_external_updated_at) {
    recordTrackerSyncAudit(db, { action: "stale_external", correlation_id: correlationID, external_id: event.external_id, issue_id: issue.id, project_id: issue.project_id, provider: event.provider });
    return { action: "stale_external", conflict: true };
  }
  const nextStatus = issueStatusFor(event.provider, event.external_status);
  if (issue.status !== nextStatus && issue.updated_at !== link.last_synced_issue_updated_at) {
    recordTrackerSyncAudit(db, { action: "local_conflict", correlation_id: correlationID, detail: { external_status: event.external_status, issue_status: issue.status }, external_id: event.external_id, issue_id: issue.id, project_id: issue.project_id, provider: event.provider });
    return { action: "local_conflict", conflict: true };
  }
  const next = issue.status === nextStatus ? issue : updateIssue(db, issue.id, { status: nextStatus });
  upsertTrackerIssueLink(db, { external_id: event.external_id, issue_id: issue.id, last_external_updated_at: event.external_updated_at, last_synced_issue_updated_at: next.updated_at, provider: event.provider });
  recordTrackerSyncAudit(db, { action: issue.status === nextStatus ? "status_unchanged" : "status_applied", correlation_id: correlationID, detail: { status: nextStatus }, external_id: event.external_id, issue_id: issue.id, project_id: issue.project_id, provider: event.provider });
  return { action: issue.status === nextStatus ? "status_unchanged" : "status_applied", conflict: false };
}

export function normalizeTrackerIssueEvent(input: TrackerIssueEvent): TrackerIssueEvent {
  const provider = trackerIssueProvider(input.provider);
  const scope = trackerScope(input.scope);
  const externalID = required(input.external_id, "external_id");
  const updatedAt = iso(input.external_updated_at);
  const normalized: TrackerIssueEvent = {
    actor: required(input.actor || "tracker", "actor"), cursor: input.cursor ? { position: required(input.cursor.position, "cursor.position"), scope: trackerScope(input.cursor.scope) } : undefined,
    description: String(input.description ?? "").trim(), event_name: required(input.event_name || "issue", "event_name"),
    external_id: externalID, external_status: required(input.external_status, "external_status").toLowerCase(), external_updated_at: updatedAt,
    payload: object(input.payload), provider, scope, title: required(input.title, "title"), url: safeURL(input.url)
  };
  const envelope: InboundEnvelope = { audit: { action_id: `${provider}:${externalID}`, correlation_id: `${provider}:${externalID}:${updatedAt}`, event_ref: `${provider}:${externalID}`, idempotency_key: `${provider}:${externalID}:${updatedAt}`, occurred_at: updatedAt }, connector_id: `${provider}-issues`, cursor: normalized.cursor ? { connector_id: `${provider}-issues`, position: normalized.cursor.position, scope: normalized.cursor.scope } : undefined, event_id: externalID, event_type: "issue", occurred_at: updatedAt, payload: { scope }, source: provider };
  const validation = validateInboundEnvelope(envelope, trackerIssueConnectorManifest(provider));
  if (!validation.ok) throw new Error(`invalid tracker connector event: ${validation.errors.join("; ")}`);
  return normalized;
}

export function trackerIssueFromPayload(provider: TrackerIssueProvider, payload: JsonObject, eventName = "issue", deliveryID?: string): TrackerIssueEvent {
  const data = provider === "github" ? object(payload.issue) : provider === "gitlab" ? object(payload.object_attributes) : object(payload.data ?? payload.issue);
  const scope = provider === "github" ? first(object(payload.repository).full_name, object(payload.repository).name) : provider === "gitlab" ? first(object(payload.project).path_with_namespace, object(payload.repository).path_with_namespace) : first(object(data.team).key, object(payload.team).key);
  const id = first(data.id, data.node_id, data.identifier, data.iid);
  const status = provider === "linear" ? first(object(data.state).type, object(data.state).name) : first(data.state, data.status);
  return { actor: provider === "github" ? first(object(payload.sender).login, "github") : provider === "gitlab" ? first(object(payload.user).username, "gitlab") : first(object(payload.actor).name, "linear"), description: first(data.body, data.description), event_name: eventName, external_id: `${trackerScope(scope)}:${required(id, "issue id")}`, external_status: status, external_updated_at: first(data.updated_at, data.updatedAt, data.created_at, data.createdAt, new Date().toISOString()), payload, provider, scope, title: required(first(data.title, data.name), "title"), url: first(data.html_url, data.web_url, data.url, `https://${provider}.invalid/${encodeURIComponent(scope)}/${encodeURIComponent(id)}`), cursor: deliveryID ? { position: deliveryID, scope } : undefined };
}

function issueStatusFor(provider: TrackerIssueProvider, value: string): string {
  const status = value.trim().toLowerCase();
  if (["closed", "completed", "complete", "done"].includes(status)) return "done";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["in progress", "in_progress", "started"].includes(status)) return "in_progress";
  if (["todo", "to do"].includes(status)) return "todo";
  return provider === "linear" && status === "backlog" ? "triage" : "triage";
}
function object(value: unknown): JsonObject { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {}; }
function first(...values: unknown[]): string { return values.map((value) => typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim()).find(Boolean) ?? ""; }
function required(value: unknown, label: string): string { const output = first(value); if (!output || output.length > 4096 || /[\0\r\n]/.test(output)) throw new Error(`${label} is invalid`); return output; }
function iso(value: unknown): string { const parsed = Date.parse(first(value)); if (!Number.isFinite(parsed)) throw new Error("external_updated_at is invalid"); return new Date(parsed).toISOString(); }
function safeURL(value: unknown): string { const output = first(value); const parsed = new URL(output); if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("issue url is invalid"); return parsed.toString(); }
