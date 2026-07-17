import type { RunnerDatabase } from "../db/database.ts";
import { createHash } from "node:crypto";
import { createExternalLink } from "../db/repositories/externalLinks.ts";
import { findExternalEventByDedupe, upsertExternalEvent, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { getStoredHandoff } from "../db/repositories/handoffs.ts";
import { getGitRepoMapping, gitEventProvider, normalizeGitRepository, type GitEventProvider } from "../db/repositories/gitRepoMappings.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { upsertAttentionInboxItemByEvidence } from "../db/repositories/attentionInboxItemUpsert.ts";
import { getIssueBackedWork, workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { buildContextBundleFromEvents } from "../pi/contextBundleBuilder.ts";
import {
  CHANNEL_CONNECTOR_CONTRACT_VERSION,
  validateInboundEnvelope,
  type ConnectorManifest,
  type InboundEnvelope
} from "./channelConnectorContracts.ts";

type JsonObject = Record<string, unknown>;
export const GIT_EVENT_TYPES = ["push", "pull_request", "review", "check", "deployment"] as const;
export type GitEventType = typeof GIT_EVENT_TYPES[number];

export function gitEventConnectorManifest(provider: GitEventProvider): ConnectorManifest {
  return {
    auth_refs: [],
    capabilities: GIT_EVENT_TYPES.map((id) => ({ id, kind: "inbound" as const, requires_authorization: true })),
    contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
    display_name: provider === "github" ? "GitHub Events" : "GitLab Events",
    id: `${provider}-events`,
    kind: "event_source"
  };
}

export type GitEventSyncInput = {
  delivery_id?: string;
  event_name: string;
  payload: JsonObject;
  provider: GitEventProvider;
  trigger?: "manual" | "webhook";
};

export type GitEventSyncResult = {
  attention_id?: number;
  event: ExternalEventRecord;
  linked: boolean;
  replayed: boolean;
  repository: string;
};

type NormalizedGitEvent = {
  actor: string;
  content: string;
  dedupe_key: string;
  event_name: string;
  event_type: GitEventType;
  external_id: string;
  occurred_at: string;
  payload: JsonObject;
  provider: GitEventProvider;
  repository: string;
};

/**
 * Deterministic Git ingress. Git remains the source of the event facts;
 * external_events is the local audit inbox, while existing Work/Handoff records
 * remain their respective state authorities.
 */
export function syncGitProviderEvent(db: RunnerDatabase, input: GitEventSyncInput): GitEventSyncResult {
  const normalized = normalizeGitProviderEvent(input);
  const mapping = getGitRepoMapping(db, normalized.provider, normalized.repository);
  const previous = findExternalEventByDedupe(db, normalized.provider, normalized.dedupe_key);
  const payloadHash = createHash("sha256").update(JSON.stringify(normalized.payload)).digest("hex");
  if (previous && clean(previous.summary.raw_payload_sha256) !== "" && clean(previous.summary.raw_payload_sha256) !== payloadHash) {
    throw new Error("git_event_dedupe_conflict");
  }
  const transaction = db.transaction(() => {
    const event = upsertExternalEvent(db, {
      actor: normalized.actor,
      content: normalized.content,
      dedupe_key: normalized.dedupe_key,
      event_type: normalized.event_type,
      external_id: normalized.external_id,
      normalized_message: {
        event_name: normalized.event_name,
        event_type: normalized.event_type,
        repository: normalized.repository
      },
      occurred_at: normalized.occurred_at,
      project_hint: normalized.repository,
      project_id: mapping?.project_id ?? "",
      provider: normalized.provider,
      raw_json: normalized.payload,
      source: normalized.provider,
      status: mapping ? "linked" : "attention",
      summary: { raw_payload_sha256: payloadHash, repository: normalized.repository, sync_trigger: input.trigger ?? "webhook" },
      trust_level: "authenticated"
    });
    if (!mapping) {
      const attention = unknownRepositoryAttention(db, event, normalized, input.trigger ?? "webhook");
      return { attention_id: attention.id, event, linked: false };
    }
    createExternalLink(db, {
      external_event_id: event.id,
      external_type: "git_event",
      project_id: mapping.project_id,
      relationship: normalized.event_type,
      source: normalized.provider
    });
    linkWorkAndHandoff(db, event, normalized, mapping.project_id);
    return { event, linked: true };
  });
  return { ...transaction.immediate(), replayed: previous !== null, repository: normalized.repository };
}

export function normalizeGitProviderEvent(input: GitEventSyncInput): NormalizedGitEvent {
  const provider = gitEventProvider(input.provider);
  const payload = objectValue(input.payload);
  const repository = repositoryFromPayload(provider, payload);
  const eventName = requiredText(input.event_name, "event_name").toLowerCase();
  const eventType = eventTypeFor(provider, eventName, payload);
  const externalID = externalIDFor(provider, eventName, payload);
  const deliveryID = clean(input.delivery_id) || `${repository}:${eventName}:${externalID}`;
  const normalized = {
    actor: actorFor(provider, payload),
    content: contentFor(eventType, payload, repository),
    dedupe_key: `${provider}:${deliveryID}`,
    event_name: eventName,
    event_type: eventType,
    external_id: `${repository}:${externalID}`,
    occurred_at: timestampFor(payload),
    payload,
    provider,
    repository
  };
  const envelope: InboundEnvelope = {
    audit: {
      action_id: `${provider}:${deliveryID}`,
      correlation_id: `${provider}:${deliveryID}`,
      event_ref: `${provider}:${normalized.external_id}`,
      idempotency_key: normalized.dedupe_key,
      occurred_at: normalized.occurred_at
    },
    connector_id: `${provider}-events`,
    event_id: normalized.external_id,
    event_type: normalized.event_type,
    occurred_at: normalized.occurred_at,
    payload: { repository: normalized.repository },
    source: provider
  };
  const validation = validateInboundEnvelope(envelope, gitEventConnectorManifest(provider));
  if (!validation.ok) throw new Error(`invalid Git connector event: ${validation.errors.join("; ")}`);
  return normalized;
}

function linkWorkAndHandoff(db: RunnerDatabase, event: ExternalEventRecord, normalized: NormalizedGitEvent, projectID: string): void {
  const refs = relatedRefs(normalized.payload);
  for (const workID of refs.work_ids) {
    let issueID = 0;
    try { issueID = workIDToIssueID(workID); } catch { continue; }
    if (getIssueBackedWork(db, workID)?.owner.project_id !== projectID) continue;
    createExternalLink(db, {
      external_event_id: event.id, external_type: "git_work", issue_id: issueID,
      project_id: projectID, relationship: normalized.event_type, source: normalized.provider
    });
  }
  for (const handoffID of refs.handoff_ids) {
    const handoff = getStoredHandoff(db, handoffID);
    if (!handoff || handoff.project_id !== projectID) continue;
    createExternalLink(db, {
      external_event_id: event.id, external_type: "git_handoff", issue_id: handoff.issue_id,
      project_id: projectID, relationship: normalized.event_type, source: normalized.provider
    });
  }
}

function unknownRepositoryAttention(
  db: RunnerDatabase,
  event: ExternalEventRecord,
  normalized: NormalizedGitEvent,
  trigger: "manual" | "webhook"
) {
  const bundle = createContextBundle(db, buildContextBundleFromEvents([event], {
    anchorEventId: event.id, createdBy: "system", source: normalized.provider, trigger
  }));
  const intake = createIntakeRun(db, {
    bundle_id: bundle.id,
    input_summary: { event_id: event.id, repository: normalized.repository, reason: "unknown_git_repository" },
    schema_output: { route: "attention" },
    skill_id: "git-repository-mapping",
    status: "succeeded"
  });
  return upsertAttentionInboxItemByEvidence(db, {
    bundle_id: bundle.id,
    confidence: 1,
    evidence_refs: [`git_repo_mapping:${normalized.provider}:${normalized.repository}`],
    intake_run_id: intake.id,
    primary_intent: "status_question",
    schema_item: { event_id: event.id, repository: normalized.repository, type: "unknown_git_repository" },
    secondary_intents: ["project_mapping"],
    source: normalized.provider,
    suggested_actions: ["map_repository"],
    summary: `Map ${normalized.provider} repository ${normalized.repository} before processing Git events.`,
    target_hints: [{ id: normalized.repository, kind: "repository", provider: normalized.provider }],
    title: `Unknown Git repository: ${normalized.repository}`,
    urgency: "medium"
  });
}

function relatedRefs(payload: JsonObject): { handoff_ids: string[]; work_ids: string[] } {
  const text = JSON.stringify(payload);
  return {
    work_ids: [...new Set(text.match(/xw:work:issues:[A-Za-z0-9._~%-]+/g) ?? [])],
    handoff_ids: [...new Set(text.match(/xw:handoff:derived:[A-Za-z0-9._~%-]+/g) ?? [])]
  };
}

function repositoryFromPayload(provider: GitEventProvider, payload: JsonObject): string {
  const repository = objectValue(payload.repository);
  return normalizeGitRepository(provider === "github"
    ? firstText(repository.full_name, repository.name_with_owner, repository.html_url, repository.clone_url)
    : firstText(repository.path_with_namespace, repository.full_name, repository.web_url, objectValue(payload.project).path_with_namespace));
}

function eventTypeFor(provider: GitEventProvider, eventName: string, payload: JsonObject): GitEventType {
  const name = eventName.toLowerCase();
  if (name === "push" || name === "push hook") return "push";
  if (name.includes("review") || name === "note hook") return "review";
  if (name.includes("check") || name === "pipeline hook" || name === "pipeline") return "check";
  if (name.includes("deployment")) return "deployment";
  if (name === "pull_request" || name === "merge request hook" || name === "merge_request") return "pull_request";
  throw new Error(`${provider} event is unsupported`);
}

function externalIDFor(provider: GitEventProvider, eventName: string, payload: JsonObject): string {
  const pull = objectValue(payload.pull_request);
  const attrs = objectValue(objectValue(payload.object_attributes));
  const check = objectValue(payload.check_run);
  const deployment = objectValue(payload.deployment);
  const commit = objectValue(payload.head_commit);
  return firstText(
    provider === "github" ? pull.id : attrs.id,
    check.id, deployment.id, commit.id, payload.after, payload.checkout_sha, payload.event_id,
    `${eventName}:${timestampFor(payload)}`
  );
}

function actorFor(provider: GitEventProvider, payload: JsonObject): string {
  const user = provider === "github" ? objectValue(payload.sender) : objectValue(payload.user);
  const pusher = objectValue(payload.pusher);
  return firstText(user.login, user.username, user.name, pusher.name, payload.user_name, "git-provider");
}

function contentFor(type: GitEventType, payload: JsonObject, repository: string): string {
  const pull = objectValue(payload.pull_request);
  const attrs = objectValue(payload.object_attributes);
  const check = objectValue(payload.check_run);
  const deployment = objectValue(payload.deployment);
  const commit = objectValue(payload.head_commit);
  const detail = firstText(pull.title, attrs.title, check.name, deployment.environment, commit.message, payload.ref, payload.ref_name, type);
  return `${repository}: ${type}${detail ? ` — ${detail}` : ""}`.slice(0, 4096);
}

function timestampFor(payload: JsonObject): string {
  const pull = objectValue(payload.pull_request);
  const attrs = objectValue(payload.object_attributes);
  const check = objectValue(payload.check_run);
  const deployment = objectValue(payload.deployment);
  const commit = objectValue(payload.head_commit);
  const value = firstText(payload.updated_at, payload.created_at, pull.updated_at, attrs.updated_at, check.completed_at, deployment.created_at, commit.timestamp);
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : new Date().toISOString();
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}
function firstText(...values: unknown[]): string { return values.map(clean).find(Boolean) ?? ""; }
function clean(value: unknown): string { return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value).trim(); }
function requiredText(value: unknown, label: string): string { const text = clean(value); if (!text) throw new Error(`${label} is required`); return text; }
