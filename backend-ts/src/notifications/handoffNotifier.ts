import type { RunnerDatabase } from "../db/database.ts";
import { createNotification, type NotificationRecord } from "../db/repositories/notifications.ts";
import {
  recordHandoff,
  type HandoffWriteContext,
  type StoredHandoffRecord
} from "../db/repositories/handoffs.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import type { EventBus } from "../events/bus.ts";
import { createPiNotificationIntent } from "../db/repositories/pi.ts";

export type HandoffNotificationSummary = {
  branch_ref: string;
  changed_file_count: number;
  commit_ref: string;
  evidence_count: number;
  external_url: string;
  handoff_id: string;
  href: string;
  mode: HandoffRecord["delivery"]["mode"];
  next_step: string;
  pull_request_ref: string;
  revision: number;
  risk_count: number;
  status: HandoffRecord["status"];
  summary: string;
  work_id: string;
};

export type RecordHandoffDeliveryInput = HandoffWriteContext & {
  bus?: EventBus;
  database: RunnerDatabase;
  handoff: HandoffRecord;
  issue_id: number;
};

export function recordHandoffDelivery(input: RecordHandoffDeliveryInput): {
  created: boolean;
  notification: NotificationRecord | null;
  record: StoredHandoffRecord;
} {
  const write = input.database.transaction(() => {
    const stored = recordHandoff(input.database, input.issue_id, input.handoff, {
      recorded_at: input.recorded_at,
      source: input.source,
      ...(input.transition ? { transition: input.transition } : {})
    });
    if (!stored.created || !["ready", "delivered"].includes(stored.record.handoff.status)) {
      return { ...stored, notification: null };
    }
    const payload = buildHandoffNotificationSummary(stored.record.handoff);
    const notification = createNotification(input.database, {
      event: `handoff.${stored.record.handoff.status}`,
      issueID: stored.record.issue_id,
      message: payload.summary,
      payload: JSON.stringify(payload),
      projectID: stored.record.project_id,
      title: stored.record.handoff.status === "delivered" ? "Handoff delivered" : "Handoff ready"
    }, new Date(input.recorded_at), 0);
    createPiNotificationIntent(input.database, {
      decision: "send_now",
      idempotency_key: `handoff:${stored.record.handoff.id}:${stored.record.handoff.revision}:${stored.record.handoff.status}:runner_ui`,
      issue_id: stored.record.issue_id,
      kind: `handoff_${stored.record.handoff.status}`,
      payload_json: payload,
      project_id: stored.record.project_id,
      ready_at: input.recorded_at,
      severity: "info",
      source_event_id: stored.record.handoff.id,
      source_event_type: "handoff.notification",
      state: "sent",
      summary: payload.summary,
      target_channel: "runner_ui"
    });
    return { ...stored, notification };
  }).immediate();

  if (write.notification) {
    input.bus?.publish({
      issueId: write.record.issue_id,
      payload: write.notification.payload,
      projectId: write.record.project_id,
      status: write.record.handoff.status,
      type: "handoff.notification"
    });
  }
  return write;
}

export function buildHandoffNotificationSummary(handoff: HandoffRecord): HandoffNotificationSummary {
  const refs = deliveryRefs(handoff);
  const nextStep = handoffNextStep(handoff);
  const fileLabel = `${handoff.changed_files.length} file${handoff.changed_files.length === 1 ? "" : "s"}`;
  const evidenceLabel = `${handoff.evidence_ids.length} Evidence`;
  const riskLabel = `${handoff.risks.length} risk${handoff.risks.length === 1 ? "" : "s"}`;
  return {
    ...refs,
    changed_file_count: handoff.changed_files.length,
    evidence_count: handoff.evidence_ids.length,
    handoff_id: handoff.id,
    href: handoffHref(handoff.id, handoff.work_id),
    mode: handoff.delivery.mode,
    next_step: nextStep,
    revision: handoff.revision,
    risk_count: handoff.risks.length,
    status: handoff.status,
    summary: `${titleCase(handoff.status)} · ${handoff.delivery.mode} · ${fileLabel} · ${evidenceLabel} · ${riskLabel} · Next: ${nextStep}`,
    work_id: handoff.work_id
  };
}

export function handoffHref(handoffID: string, workID = ""): string {
  return workID
    ? `#/work/${encodeURIComponent(workID)}/delivery/${encodeURIComponent(handoffID)}`
    : `#/handoffs/${encodeURIComponent(handoffID)}`;
}

export function handoffNextStep(handoff: HandoffRecord): string {
  if (handoff.status === "superseded") return "Open the replacement Handoff";
  if (handoff.status === "delivered") return "Confirm downstream delivery";
  if (handoff.review.state === "changes_requested") return "Address review findings";
  if (handoff.review.required && handoff.review.state !== "approved") return "Complete required review";
  const pending = handoff.delivery_actions.find((action) => action.required && action.outcome !== "succeeded");
  if (pending) return `Complete ${pending.action.replaceAll("_", " ")}`;
  if (handoff.status === "draft") return "Pass required Evidence";
  return "Open delivery artifact";
}

function deliveryRefs(handoff: HandoffRecord): Pick<
  HandoffNotificationSummary,
  "branch_ref" | "commit_ref" | "external_url" | "pull_request_ref"
> {
  const delivery = handoff.delivery;
  return {
    branch_ref: "branch_ref" in delivery ? delivery.branch_ref : "",
    commit_ref: "commit_ref" in delivery ? delivery.commit_ref : "",
    external_url: "url" in delivery ? safeExternalURL(delivery.url) : "",
    pull_request_ref: "pull_request_ref" in delivery ? delivery.pull_request_ref : ""
  };
}

function safeExternalURL(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}
