import type { RunnerDatabase } from "../../db/database.ts";
import { createExternalLink } from "../../db/repositories/externalLinks.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import {
  createPiActionEvent,
  getPiAction,
  listPiActionEvents,
  updatePiAction,
  upsertPiGuardianAlert,
  type PiAction,
  type PiActionEvent
} from "../../db/repositories/pi.ts";
import {
  claimTrackerUpdateOutbox,
  enqueueTrackerUpdateOutbox,
  listDispatchableTrackerUpdates,
  markTrackerUpdateFailed,
  markTrackerUpdateRetry,
  markTrackerUpdateSent,
  type TrackerUpdateOutboxRecord
} from "../../db/repositories/trackerUpdateOutbox.ts";
import {
  buildTrackerUpdateCommand,
  normalizeTrackerReceipt,
  TRACKER_UPDATE_ACTION,
  TrackerAdapterError,
  trackerTargetRef,
  trackerUpdateAuthorizationPayload,
  type TrackerAdapter,
  type TrackerStatusMapping,
  type TrackerTarget,
  type TrackerVerification
} from "../../integrations/tracker/contracts.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  validateHandoff,
  type HandoffLinkContext,
  type HandoffRecord
} from "./contracts.ts";

export type QueueTrackerUpdateInput = {
  authorization_action_id: string;
  handoff: HandoffRecord;
  handoff_context: HandoffLinkContext;
  idempotency_key: string;
  issue_id: number;
  max_attempts?: number;
  project_id: string;
  status_mapping: TrackerStatusMapping;
  target: TrackerTarget;
  verification: readonly TrackerVerification[];
};

export type TrackerUpdateDispatchResult = {
  attention: number;
  processed: number;
  retry: number;
  sent: number;
  skipped: number;
};

export function createTrackerUpdateHandoffService(options: {
  adapters: readonly TrackerAdapter[];
  database: RunnerDatabase;
  now?: () => Date;
}): {
  dispatch(input?: { lease_seconds?: number; limit?: number }): Promise<TrackerUpdateDispatchResult>;
  enqueue(input: QueueTrackerUpdateInput): TrackerUpdateOutboxRecord;
} {
  const adapters = adapterRegistry(options.adapters);
  const now = options.now ?? (() => new Date());
  return {
    enqueue(input) {
      const command = buildTrackerUpdateCommand({
        correlation_id: `tracker-update:${input.idempotency_key}`,
        handoff: input.handoff,
        idempotency_key: input.idempotency_key,
        project_id: input.project_id,
        status_mapping: input.status_mapping,
        target: input.target,
        verification: input.verification
      });
      validateQueueInput(options.database, input, command);
      const authorization = requireAuthorization(options.database, input.authorization_action_id, command, input.issue_id);
      const eventRef = `pi_action_events:${authorization.event.id}`;
      requireHandoffTrackerAction(input.handoff, command.target, eventRef);
      return options.database.transaction(() => {
        const queued = enqueueTrackerUpdateOutbox(options.database, {
          authorization_action_id: authorization.action.id,
          command,
          issue_id: input.issue_id,
          max_attempts: input.max_attempts
        }, now());
        if (!queued.created) return queued.record;
        updatePiAction(options.database, authorization.action.id, { status: "executing" });
        recordAudit(options.database, queued.record, "handoff.tracker_update.queued.v1", {
          decision: "execute",
          payload: { authorization_event_ref: eventRef, outbox_id: queued.record.id }
        });
        return queued.record;
      }).immediate();
    },
    async dispatch(input = {}) {
      const result = emptyResult();
      const timestamp = now();
      const candidates = listDispatchableTrackerUpdates(options.database, { limit: input.limit, now: timestamp });
      for (const candidate of candidates) {
        const claimed = options.database.transaction(() => {
          const record = claimTrackerUpdateOutbox(options.database, candidate.id, {
            lease_seconds: input.lease_seconds,
            now: timestamp
          });
          if (!record) return null;
          recordAudit(options.database, record, "handoff.tracker_update.attempt.v1", {
            decision: "execute",
            payload: { attempt: record.attempt_count, outbox_id: record.id }
          });
          return record;
        }).immediate();
        if (!claimed) {
          result.skipped += 1;
          continue;
        }
        result.processed += 1;
        await dispatchOne(options.database, adapters, claimed, timestamp, result);
      }
      return result;
    }
  };
}

async function dispatchOne(
  db: RunnerDatabase,
  adapters: ReadonlyMap<string, TrackerAdapter>,
  outbox: TrackerUpdateOutboxRecord,
  timestamp: Date,
  result: TrackerUpdateDispatchResult
): Promise<void> {
  try {
    const authorization = requireAuthorization(
      db,
      outbox.authorization_action_id,
      outbox.command,
      outbox.issue_id
    );
    const adapter = adapters.get(outbox.command.target.provider_id);
    if (!adapter) throw new TrackerAdapterError("Tracker adapter is not registered", { retryable: false });
    const receipt = normalizeTrackerReceipt(await adapter.applyUpdate(outbox.command, {
      attempt: outbox.attempt_count,
      authorization_action_id: authorization.action.id,
      authorization_event_ref: `pi_action_events:${authorization.event.id}`,
      outbox_id: outbox.id
    }), outbox.command);
    db.transaction(() => {
      createExternalLink(db, {
        external_id: receipt.external_id,
        external_type: receipt.external_type,
        issue_id: outbox.issue_id,
        project_id: outbox.command.project_id,
        relationship: "handoff_tracker_update",
        source: outbox.command.target.provider_id
      }, timestamp);
      markTrackerUpdateSent(db, outbox.id, { receipt, timestamp });
      updatePiAction(db, authorization.action.id, {
        result_json: JSON.stringify(receipt),
        status: "completed"
      });
      recordAudit(db, outbox, "handoff.tracker_update.outcome.v1", {
        decision: "execute",
        result: {
          external_id: receipt.external_id,
          external_status: receipt.external_status,
          provider_request_ref: receipt.provider_request_ref,
          replayed: receipt.replayed,
          status: "succeeded"
        }
      });
    }).immediate();
    result.sent += 1;
  } catch (error) {
    handleDispatchFailure(db, outbox, error, timestamp, result);
  }
}

function handleDispatchFailure(
  db: RunnerDatabase,
  outbox: TrackerUpdateOutboxRecord,
  error: unknown,
  timestamp: Date,
  result: TrackerUpdateDispatchResult
): void {
  const summary = safeError(error);
  const retryable = !(error instanceof TrackerAdapterError) || error.retryable;
  if (retryable && outbox.attempt_count < outbox.max_attempts) {
    const retryAfter = error instanceof TrackerAdapterError ? error.retry_after_seconds : 0;
    db.transaction(() => {
      markTrackerUpdateRetry(db, outbox.id, {
        error: summary,
        retry_after_seconds: retryAfter || undefined,
        timestamp
      });
      recordAudit(db, outbox, "handoff.tracker_update.retry.v1", {
        error: summary,
        result: { attempt: outbox.attempt_count, status: "retry" }
      });
    }).immediate();
    result.retry += 1;
    return;
  }

  db.transaction(() => {
    const alert = upsertPiGuardianAlert(db, {
      alert_type: "handoff_tracker_update_failed",
      evidence_json: JSON.stringify([
        `sync_outbox:${outbox.id}`,
        outbox.command.handoff_id,
        `pi_actions:${outbox.authorization_action_id}`,
        trackerTargetRef(outbox.command.target)
      ]),
      id: `handoff-tracker-update-${outbox.id}`,
      issue_id: outbox.issue_id,
      message: `Tracker update failed after ${outbox.attempt_count} attempt(s): ${summary}`,
      project_id: outbox.command.project_id,
      severity: "urgent",
      status: "open"
    });
    const attentionRef = `pi_guardian_alerts:${alert.id}`;
    markTrackerUpdateFailed(db, outbox.id, { attention_ref: attentionRef, error: summary, timestamp });
    if (getPiAction(db, outbox.authorization_action_id)) {
      updatePiAction(db, outbox.authorization_action_id, {
        result_json: JSON.stringify({ attention_ref: attentionRef, error: summary }),
        status: "failed"
      });
    }
    recordAudit(db, outbox, "handoff.tracker_update.outcome.v1", {
      error: summary,
      result: { attention_ref: attentionRef, status: "failed" }
    });
  }).immediate();
  result.attention += 1;
}

function validateQueueInput(
  db: RunnerDatabase,
  input: QueueTrackerUpdateInput,
  command: ReturnType<typeof buildTrackerUpdateCommand>
): void {
  const validation = validateHandoff(input.handoff, input.handoff_context);
  if (!validation.ok) throw new Error(`tracker update Handoff validation failed: ${validation.errors.join("; ")}`);
  const issue = getIssue(db, input.issue_id);
  if (!issue) throw new Error("tracker update issue not found");
  if (issue.project_id !== command.project_id) throw new Error("tracker update project does not match issue");
}

function requireAuthorization(
  db: RunnerDatabase,
  actionID: string,
  command: ReturnType<typeof buildTrackerUpdateCommand>,
  issueID: number
): { action: PiAction; event: PiActionEvent } {
  const action = getPiAction(db, actionID);
  if (!action) throw new Error("tracker update authorization action not found");
  if (action.action_type !== TRACKER_UPDATE_ACTION) throw new Error("tracker update authorization action type mismatch");
  if (action.project_id !== command.project_id || action.issue_id !== issueID) {
    throw new Error("tracker update authorization scope mismatch");
  }
  if (action.gate_decision !== "execute") throw new Error("tracker update authorization is not allowed");
  if (!["approved", "executing", "completed"].includes(action.status)) {
    throw new Error(`tracker update authorization action is not executable: ${action.status}`);
  }
  requireAuthorizationPayload(action.payload_json, trackerUpdateAuthorizationPayload(command));
  const event = latestGateEvent(listPiActionEvents(db, { actionId: action.id }));
  if (!event) throw new Error("tracker update authorization gate audit is missing");
  return { action, event };
}

function latestGateEvent(events: readonly PiActionEvent[]): PiActionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const candidate = events[index];
    if (candidate?.event_type === "gate_decision" && candidate.decision === "execute") return candidate;
  }
  return undefined;
}

function requireAuthorizationPayload(value: string, expected: Record<string, unknown>): void {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new Error("tracker update authorization payload is invalid");
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (JSON.stringify(payload[key]) !== JSON.stringify(expectedValue)) {
      throw new Error(`tracker update authorization payload mismatch: ${key}`);
    }
  }
}

function requireHandoffTrackerAction(handoff: HandoffRecord, target: TrackerTarget, eventRef: string): void {
  const targetRef = trackerTargetRef(target);
  const action = handoff.delivery_actions.find((candidate) =>
    candidate.action === "tracker_update" && candidate.target === targetRef
  );
  if (!action) throw new Error("Handoff tracker_update delivery action is missing");
  if (action.classification !== "external_write" || action.gate_decision !== "allow") {
    throw new Error("Handoff tracker_update delivery action is not authorized");
  }
  if (action.outcome !== "not_executed") throw new Error("Handoff tracker_update delivery action was already executed");
  if (action.audit_event_ref !== eventRef) throw new Error("Handoff tracker_update audit event does not match authorization");
}

function recordAudit(
  db: RunnerDatabase,
  outbox: TrackerUpdateOutboxRecord,
  eventType: string,
  input: { decision?: string; error?: string; payload?: unknown; result?: unknown }
): void {
  createPiActionEvent(db, {
    action_id: outbox.authorization_action_id,
    actor: "tracker_dispatcher",
    decision: input.decision ?? "",
    error: input.error ?? "",
    event_type: eventType,
    issue_id: outbox.issue_id,
    payload_json: JSON.stringify(input.payload ?? {}),
    project_id: outbox.command.project_id,
    result_json: JSON.stringify(input.result ?? {})
  });
}

function adapterRegistry(adapters: readonly TrackerAdapter[]): ReadonlyMap<string, TrackerAdapter> {
  const registry = new Map<string, TrackerAdapter>();
  for (const adapter of adapters) {
    const providerID = adapter.provider_id.trim().toLowerCase();
    if (providerID === "") throw new Error("tracker adapter provider id is required");
    if (registry.has(providerID)) throw new Error(`duplicate tracker adapter provider id: ${providerID}`);
    registry.set(providerID, adapter);
  }
  return registry;
}

function emptyResult(): TrackerUpdateDispatchResult {
  return { attention: 0, processed: 0, retry: 0, sent: 0, skipped: 0 };
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
