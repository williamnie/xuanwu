import { createHash } from "node:crypto";
import { redactedUserVisibleText } from "../../util/redact.ts";
import { parseDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type { HandoffRecord, HandoffStatus } from "../../domain/handoff/contracts.ts";

export const TRACKER_UPDATE_ACTION = "handoff.tracker_update" as const;

export type TrackerTarget = {
  external_id: string;
  external_type: string;
  provider_id: string;
};

export type TrackerStatusMapping = Readonly<Record<HandoffStatus, string | null>>;

export type TrackerVerification = {
  command: string;
  outcome: "failed" | "passed" | "skipped";
  summary?: string;
};

export type TrackerUpdateCommand = {
  comment: string;
  correlation_id: string;
  external_status: string | null;
  handoff_id: HandoffRecord["id"];
  idempotency_key: string;
  project_id: string;
  target: TrackerTarget;
  work_id: HandoffRecord["work_id"];
};

export type TrackerWriteContext = {
  attempt: number;
  authorization_action_id: string;
  authorization_event_ref: string;
  outbox_id: number;
};

export type TrackerAdapterReceipt = {
  comment_ref: string;
  external_id: string;
  external_status: string | null;
  external_type: string;
  provider_request_ref: string;
  replayed: boolean;
  url: string;
};

export interface TrackerAdapter {
  readonly provider_id: string;
  applyUpdate(command: TrackerUpdateCommand, context: TrackerWriteContext): Promise<TrackerAdapterReceipt>;
}

export class TrackerAdapterError extends Error {
  readonly retry_after_seconds: number;
  readonly retryable: boolean;

  constructor(message: string, options: { retry_after_seconds?: number; retryable: boolean }) {
    super(redactedUserVisibleText(message) || "Tracker adapter error");
    this.name = "TrackerAdapterError";
    this.retry_after_seconds = positiveInteger(options.retry_after_seconds);
    this.retryable = options.retryable;
  }
}

export function buildTrackerUpdateCommand(input: {
  correlation_id: string;
  handoff: HandoffRecord;
  idempotency_key: string;
  project_id: string;
  status_mapping: TrackerStatusMapping;
  target: TrackerTarget;
  verification: readonly TrackerVerification[];
}): TrackerUpdateCommand {
  const target = normalizeTrackerTarget(input.target);
  const handoffID = requiredText(input.handoff.id, "handoff id", 8192);
  const workID = requiredText(input.handoff.work_id, "work id", 8192);
  if (parseDomainID(handoffID)?.kind !== "handoff") throw new Error("handoff id is invalid");
  if (parseDomainID(workID)?.kind !== "work") throw new Error("work id is invalid");
  return {
    comment: buildTrackerHandoffComment(input.handoff, input.verification),
    correlation_id: requiredText(input.correlation_id, "correlation id", 4096),
    external_status: trackerStatus(input.status_mapping[input.handoff.status]),
    handoff_id: input.handoff.id,
    idempotency_key: requiredText(input.idempotency_key, "idempotency key", 256),
    project_id: requiredText(input.project_id, "project id", 128),
    target,
    work_id: input.handoff.work_id
  };
}

export function trackerUpdateAuthorizationPayload(command: TrackerUpdateCommand): Record<string, unknown> {
  return {
    comment_sha256: createHash("sha256").update(command.comment).digest("hex"),
    external_status: command.external_status,
    handoff_id: command.handoff_id,
    idempotency_key: command.idempotency_key,
    operation: "tracker_update",
    target: command.target,
    work_id: command.work_id
  };
}

export function trackerTargetRef(input: TrackerTarget): string {
  const target = normalizeTrackerTarget(input);
  return `tracker://${target.provider_id}/${encodeURIComponent(target.external_type)}/${encodeURIComponent(target.external_id)}`;
}

export function normalizeTrackerReceipt(
  input: TrackerAdapterReceipt,
  command: TrackerUpdateCommand
): TrackerAdapterReceipt {
  const target = normalizeTrackerTarget({
    external_id: input.external_id,
    external_type: input.external_type,
    provider_id: command.target.provider_id
  });
  if (target.external_id !== command.target.external_id || target.external_type !== command.target.external_type) {
    throw new TrackerAdapterError("Tracker adapter receipt target mismatch", { retryable: false });
  }
  const externalStatus = trackerStatus(input.external_status);
  if (externalStatus !== command.external_status) {
    throw new TrackerAdapterError("Tracker adapter receipt status mismatch", { retryable: false });
  }
  return {
    comment_ref: requiredText(input.comment_ref, "tracker comment ref", 8192),
    external_id: target.external_id,
    external_status: externalStatus,
    external_type: target.external_type,
    provider_request_ref: requiredText(input.provider_request_ref, "provider request ref", 8192),
    replayed: input.replayed === true,
    url: safeURL(input.url)
  };
}

function buildTrackerHandoffComment(handoff: HandoffRecord, verification: readonly TrackerVerification[]): string {
  const checks = verification.length === 0
    ? ["- skipped — No verification recorded"]
    : verification.map((item) => {
      const summary = item.summary ? ` — ${safeText(item.summary)}` : "";
      return `- ${item.outcome} — \`${safeCode(item.command)}\`${summary}`;
    });
  const risks = handoff.risks.length === 0
    ? ["- none"]
    : handoff.risks.map((risk) => `- ${risk.severity}: ${safeText(risk.summary)}`);
  return [
    "## Handoff",
    safeText(handoff.summary),
    "",
    `- Handoff: \`${safeCode(handoff.id)}\``,
    `- Status: ${handoff.status}`,
    ...deliveryLines(handoff),
    "",
    "## Verification",
    ...checks,
    "",
    "## Review",
    `- Required: ${handoff.review.required ? "yes" : "no"}`,
    `- State: ${handoff.review.state}`,
    `- Ref: ${safeText(handoff.review.review_ref || handoff.review_ref)}`,
    "",
    "## Risks",
    ...risks
  ].join("\n");
}

function deliveryLines(handoff: HandoffRecord): string[] {
  const delivery = handoff.delivery;
  switch (delivery.mode) {
    case "local_changes": return [`- Working tree: \`${safeCode(delivery.working_tree_ref)}\``];
    case "branch_commit": return branchLines(delivery.branch_ref, delivery.commit_ref);
    case "push": return [...branchLines(delivery.branch_ref, delivery.commit_ref), `- Remote: \`${safeCode(delivery.remote_ref)}\``];
    case "draft_pr":
    case "ready_pr":
      return [...branchLines(delivery.branch_ref, delivery.commit_ref),
        `- Remote: \`${safeCode(delivery.remote_ref)}\``,
        `- Pull request: \`${safeCode(delivery.pull_request_ref)}\``];
    case "deploy": return [`- Environment: ${safeText(delivery.environment)}`, `- Revision: \`${safeCode(delivery.revision_ref)}\``];
    case "release": return [`- Version: ${safeText(delivery.version)}`, `- Revision: \`${safeCode(delivery.revision_ref)}\``];
  }
}

function branchLines(branch: string, commit: string): string[] {
  return [`- Branch: \`${safeCode(branch)}\``, `- Commit: \`${safeCode(commit)}\``];
}

function normalizeTrackerTarget(input: TrackerTarget): TrackerTarget {
  const providerID = requiredText(input.provider_id, "tracker provider id", 128).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(providerID)) throw new Error("tracker provider id is invalid");
  return {
    external_id: requiredText(input.external_id, "tracker external id", 4096),
    external_type: requiredText(input.external_type, "tracker external type", 128),
    provider_id: providerID
  };
}

function trackerStatus(value: string | null): string | null {
  return value === null ? null : requiredText(value, "tracker status", 128);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  if (/\0|\r|\n/.test(text)) throw new Error(`${label} cannot contain control lines`);
  return text;
}

function safeText(value: string): string {
  return redactedUserVisibleText(value) || "Not provided";
}

function safeCode(value: string): string {
  return safeText(value).replaceAll("`", "'");
}

function safeURL(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TrackerAdapterError("Tracker adapter receipt URL is invalid", { retryable: false });
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TrackerAdapterError("Tracker adapter receipt URL is unsafe", { retryable: false });
  }
  for (const key of parsed.searchParams.keys()) {
    if (/token|secret|password|api[_-]?key|auth/i.test(key)) {
      throw new TrackerAdapterError("Tracker adapter receipt URL contains credential parameters", { retryable: false });
    }
  }
  return parsed.toString();
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
