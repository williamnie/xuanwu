import { createHash, createHmac } from "node:crypto";
import {
  CHANNEL_CONNECTOR_CONTRACT_VERSION,
  assertConnectorConformance,
  type ChannelConnector,
  type ConnectorManifest
} from "./channelConnectorContracts.ts";

const OPENCLAW_GATEWAY_ID = "openclaw-gateway";
const WORK_CREATE_EVENT = "work.create";
const MAX_TEXT_LENGTH = 4096;

/**
 * Optional boundary adapter for an OpenClaw plugin. It only translates the
 * plugin's transport objects to existing Runner HTTP contracts; it is not an
 * OpenClaw memory store, session runtime, outbox, or approval authority.
 */
export const OPENCLAW_GATEWAY_MANIFEST: ConnectorManifest = {
  auth_refs: [{ kind: "secret_ref", ref: "env://XUANWU_WEBHOOK_SIGNING_SECRET" }],
  capabilities: [
    { id: WORK_CREATE_EVENT, kind: "inbound", requires_authorization: true },
    { id: "approval.callback", kind: "inbound", requires_authorization: true },
    { id: "work.query", kind: "read", requires_authorization: false },
    { id: "handoff.query", kind: "read", requires_authorization: false }
  ],
  contract_version: CHANNEL_CONNECTOR_CONTRACT_VERSION,
  display_name: "OpenClaw Gateway",
  id: OPENCLAW_GATEWAY_ID,
  kind: "channel"
};

export type OpenClawSessionInput = {
  channel_id: string;
  session_id: string;
  user_id: string;
};

export type OpenClawSessionMapping = {
  connector_id: typeof OPENCLAW_GATEWAY_ID;
  identity_ref: string;
  session_ref: string;
};

export type OpenClawWorkCreateInput = OpenClawSessionInput & {
  event_id: string;
  goal: string;
  occurred_at: string;
  project_id: string;
  status?: "todo" | "triage";
  title: string;
};

export type OpenClawWebhookRequest = {
  body: Record<string, unknown>;
  event_id: string;
  idempotency_key: string;
  mapping: OpenClawSessionMapping;
};

export type OpenClawSignedWebhookRequest = OpenClawWebhookRequest & {
  headers: Record<string, string>;
  raw_body: string;
};

export type RunnerApprovalBinding = {
  id: string;
  session_id?: string;
  thread_id?: string;
};

export type OpenClawApprovalCallbackInput = OpenClawSessionInput & {
  approval: RunnerApprovalBinding;
  decision: "approve" | "approve_session" | "defer" | "deny";
  runner_session_id: string;
  scope?: "session" | "turn";
};

export type OpenClawApprovalResolveRequest = {
  body: { decision: OpenClawApprovalCallbackInput["decision"]; scope: "session" | "turn" };
  mapping: OpenClawSessionMapping;
  method: "POST";
  path: string;
};

export type OpenClawHandoffResponseInput = OpenClawSessionInput & {
  handoff: Record<string, unknown>;
  runner_session_id: string;
};

/** Return stable, opaque refs so same channel/user/session retries correlate without cross-channel collisions. */
export function mapOpenClawSession(input: OpenClawSessionInput): OpenClawSessionMapping {
  const channelID = requiredText(input.channel_id, "channel_id", 256);
  const userID = requiredText(input.user_id, "user_id", 512);
  const sessionID = requiredText(input.session_id, "session_id", 512);
  return {
    connector_id: OPENCLAW_GATEWAY_ID,
    identity_ref: `openclaw:identity:${digest(channelID, userID)}`,
    session_ref: `openclaw:session:${digest(channelID, userID, sessionID)}`
  };
}

/** Build the existing signed `work.create` webhook payload; no new Work writer is introduced. */
export function buildOpenClawWorkCreate(input: OpenClawWorkCreateInput): OpenClawWebhookRequest {
  const mapping = mapOpenClawSession(input);
  const eventID = requiredText(input.event_id, "event_id", 512);
  const occurredAt = timestamp(input.occurred_at, "occurred_at");
  const projectID = requiredText(input.project_id, "project_id", 256);
  const title = requiredText(input.title, "title", MAX_TEXT_LENGTH);
  const goal = requiredText(input.goal, "goal", MAX_TEXT_LENGTH);
  const status = input.status ?? "triage";
  if (status !== "todo" && status !== "triage") throw new Error("status must be todo or triage");

  const eventRef = `openclaw:event:${digest(mapping.session_ref, eventID)}`;
  return {
    body: {
      data: {
        gateway: {
          connector_id: mapping.connector_id,
          identity_ref: mapping.identity_ref,
          session_ref: mapping.session_ref,
          source_event_ref: eventRef
        },
        goal,
        project_id: projectID,
        status,
        title
      },
      id: eventRef,
      occurred_at: occurredAt,
      type: WORK_CREATE_EVENT
    },
    event_id: eventRef,
    idempotency_key: `openclaw:work:${digest(mapping.session_ref, eventID, projectID, title, goal, status)}`,
    mapping
  };
}

/** Sign a Work request for the P09.03 endpoint. The caller owns transport and never sends this secret to Runner as data. */
export function signOpenClawWorkCreate(
  input: OpenClawWorkCreateInput,
  signingSecret: string,
  timestampValue = new Date().toISOString()
): OpenClawSignedWebhookRequest {
  const secret = requiredText(signingSecret, "signingSecret", MAX_TEXT_LENGTH);
  const request = buildOpenClawWorkCreate(input);
  const occurredAt = timestamp(timestampValue, "timestamp");
  const rawBody = JSON.stringify(request.body);
  const signature = createHmac("sha256", secret).update(`${occurredAt}.${rawBody}`).digest("hex");
  return {
    ...request,
    headers: {
      "content-type": "application/json",
      "idempotency-key": request.idempotency_key,
      "x-xuanwu-signature": `v1=${signature}`,
      "x-xuanwu-timestamp": occurredAt
    },
    raw_body: rawBody
  };
}

/**
 * Bind a callback to the exact Runner session before it reaches the existing
 * authenticated PI approval resolver. This prevents a channel/session from
 * resolving another session's pending approval.
 */
export function buildOpenClawApprovalCallback(input: OpenClawApprovalCallbackInput): OpenClawApprovalResolveRequest {
  const mapping = mapOpenClawSession(input);
  const approvalID = requiredText(input.approval.id, "approval.id", 512);
  const runnerSessionID = requiredText(input.runner_session_id, "runner_session_id", 512);
  const boundSession = optionalText(input.approval.session_id) || optionalText(input.approval.thread_id);
  if (boundSession === "" || boundSession !== runnerSessionID) {
    throw new Error("approval is not bound to the mapped Runner session");
  }
  const scope = input.scope ?? "turn";
  if (scope !== "turn" && scope !== "session") throw new Error("scope must be turn or session");
  return {
    body: { decision: input.decision, scope },
    mapping,
    method: "POST",
    path: `/api/pi/approval-requests/${encodeURIComponent(approvalID)}/resolve`
  };
}

/** Project an existing Handoff response back to the originating OpenClaw session without dispatching an external write. */
export function buildOpenClawHandoffResponse(input: OpenClawHandoffResponseInput): Record<string, unknown> {
  const mapping = mapOpenClawSession(input);
  const runnerSessionID = requiredText(input.runner_session_id, "runner_session_id", 512);
  const handoff = object(input.handoff, "handoff");
  return {
    handoff,
    mapping,
    runner_session_id: runnerSessionID,
    type: "handoff.response"
  };
}

export function assertOpenClawGatewayAdapterConformance(): void {
  assertConnectorConformance({
    manifest: OPENCLAW_GATEWAY_MANIFEST,
    health: () => ({ checked_at: new Date().toISOString(), last_error: "", reconnect_attempts: 0, state: "healthy" }),
    ingest: () => undefined
  } satisfies ChannelConnector);
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
}

function requiredText(value: unknown, label: string, maximum: number): string {
  const text = optionalText(value);
  if (text === "") throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timestamp(value: unknown, label: string): string {
  const text = requiredText(value, label, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO timestamp`);
  return text;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
