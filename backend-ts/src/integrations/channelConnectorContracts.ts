import { redactSensitiveText } from "../util/redact.ts";

/**
 * P09.01's additive contract.  It deliberately describes adapters without
 * becoming an alternate writer for external_events, PI actions, or outboxes.
 */
export const CHANNEL_CONNECTOR_CONTRACT_VERSION = 1 as const;

export const CONNECTOR_KINDS = ["channel", "event_source", "tool_provider", "external_target"] as const;
export type ConnectorKind = typeof CONNECTOR_KINDS[number];

export const CONNECTOR_HEALTH_STATES = ["disabled", "healthy", "degraded", "disconnected", "failed"] as const;
export type ConnectorHealthState = typeof CONNECTOR_HEALTH_STATES[number];

export type ConnectorAuthRef = {
  kind: "secret_ref";
  ref: string;
};

export type ConnectorCapability = {
  id: string;
  kind: "inbound" | "outbound" | "read" | "tool";
  requires_authorization: boolean;
};

export type ConnectorManifest = {
  auth_refs: ConnectorAuthRef[];
  capabilities: ConnectorCapability[];
  contract_version: typeof CHANNEL_CONNECTOR_CONTRACT_VERSION;
  display_name: string;
  id: string;
  kind: ConnectorKind;
};

export type ConnectorHealth = {
  checked_at: string;
  last_error: string;
  reconnect_attempts: number;
  state: ConnectorHealthState;
};

export type ConnectorCursor = {
  connector_id: string;
  position: string;
  scope: string;
};

export type ConnectorRateLimit = {
  limit?: number;
  remaining?: number;
  reset_at?: string;
  retry_after_seconds?: number;
};

export type ConnectorAudit = {
  action_id: string;
  correlation_id: string;
  event_ref: string;
  idempotency_key: string;
  occurred_at: string;
};

export type InboundEnvelope = {
  audit: ConnectorAudit;
  connector_id: string;
  cursor?: ConnectorCursor;
  event_id: string;
  event_type: string;
  occurred_at: string;
  payload: Record<string, unknown>;
  source: string;
};

export type OutboundEnvelope = {
  audit: ConnectorAudit;
  authorization: {
    action_gate_ref: string;
    authority: "deterministic_policy" | "human_approval";
    decision: "allow";
  };
  connector_id: string;
  idempotency_key: string;
  operation: string;
  payload: Record<string, unknown>;
  target: string;
};

export type ConnectorDeliveryReceipt = {
  provider_request_ref: string;
  rate_limit?: ConnectorRateLimit;
  replayed: boolean;
  target: string;
};

export interface ChannelConnector {
  readonly manifest: ConnectorManifest;
  health(): Promise<ConnectorHealth> | ConnectorHealth;
  ingest?(envelope: InboundEnvelope): Promise<void> | void;
  deliver?(envelope: OutboundEnvelope): Promise<ConnectorDeliveryReceipt>;
}

export type ConnectorConformanceResult = { errors: string[]; ok: boolean };

export function validateConnectorManifest(value: unknown): ConnectorConformanceResult {
  const errors: string[] = [];
  const manifest = record(value, "manifest", errors);
  if (!manifest) return result(errors);
  if (manifest.contract_version !== CHANNEL_CONNECTOR_CONTRACT_VERSION) errors.push("manifest.contract_version is unsupported");
  text(manifest.id, "manifest.id", errors, 128, idPattern);
  text(manifest.display_name, "manifest.display_name", errors, 256);
  if (!CONNECTOR_KINDS.includes(manifest.kind as ConnectorKind)) errors.push("manifest.kind is unsupported");
  capabilities(manifest.capabilities, errors);
  authRefs(manifest.auth_refs, errors);
  return result(errors);
}

export function validateInboundEnvelope(value: unknown, manifest?: ConnectorManifest): ConnectorConformanceResult {
  const errors: string[] = [];
  const envelope = record(value, "inbound envelope", errors);
  if (!envelope) return result(errors);
  text(envelope.connector_id, "inbound.connector_id", errors, 128, idPattern);
  text(envelope.event_id, "inbound.event_id", errors, 512);
  text(envelope.event_type, "inbound.event_type", errors, 256);
  text(envelope.occurred_at, "inbound.occurred_at", errors, 64);
  text(envelope.source, "inbound.source", errors, 128, idPattern);
  payload(envelope.payload, "inbound.payload", errors);
  audit(envelope.audit, errors);
  cursor(envelope.cursor, envelope.connector_id, errors);
  if (manifest) {
    connectorMatch(envelope.connector_id, manifest, errors);
    if (!manifest.capabilities.some((item) => item.kind === "inbound" && item.id === envelope.event_type)) {
      errors.push("inbound.event_type is not declared by manifest");
    }
  }
  return result(errors);
}

export function validateOutboundEnvelope(value: unknown, manifest?: ConnectorManifest): ConnectorConformanceResult {
  const errors: string[] = [];
  const envelope = record(value, "outbound envelope", errors);
  if (!envelope) return result(errors);
  text(envelope.connector_id, "outbound.connector_id", errors, 128, idPattern);
  text(envelope.idempotency_key, "outbound.idempotency_key", errors, 256);
  text(envelope.operation, "outbound.operation", errors, 256, idPattern);
  text(envelope.target, "outbound.target", errors, 4096);
  payload(envelope.payload, "outbound.payload", errors);
  audit(envelope.audit, errors);
  authorization(envelope.authorization, errors);
  if (manifest) connectorMatch(envelope.connector_id, manifest, errors);
  return result(errors);
}

export function validateConnectorHealth(value: unknown): ConnectorConformanceResult {
  const errors: string[] = [];
  const health = record(value, "connector health", errors);
  if (!health) return result(errors);
  text(health.checked_at, "health.checked_at", errors, 64);
  optionalSafeText(health.last_error, "health.last_error", errors, 4096);
  if (!CONNECTOR_HEALTH_STATES.includes(health.state as ConnectorHealthState)) errors.push("health.state is unsupported");
  if (!nonNegativeInteger(health.reconnect_attempts)) errors.push("health.reconnect_attempts must be a non-negative integer");
  return result(errors);
}

/** Fail closed before invoking an adapter. */
export function assertOutboundEnvelope(value: unknown, manifest?: ConnectorManifest): asserts value is OutboundEnvelope {
  const validation = validateOutboundEnvelope(value, manifest);
  if (!validation.ok) throw new Error(`invalid outbound connector envelope: ${validation.errors.join("; ")}`);
}

export function assertConnectorConformance(connector: ChannelConnector): void {
  const manifest = validateConnectorManifest(connector.manifest);
  if (!manifest.ok) throw new Error(`invalid connector manifest: ${manifest.errors.join("; ")}`);
  if (connector.manifest.capabilities.some((item) => item.kind === "inbound") && typeof connector.ingest !== "function") {
    throw new Error("connector declares inbound capability without ingest");
  }
  if (connector.manifest.capabilities.some((item) => item.kind === "outbound") && typeof connector.deliver !== "function") {
    throw new Error("connector declares outbound capability without deliver");
  }
}

/** Safe for status/audit surfaces; auth references remain opaque and payload secrets are never emitted. */
export function redactConnectorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConnectorValue);
  if (!value || typeof value !== "object") return typeof value === "string" ? redactSensitiveText(value) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (secretKey.test(key)) return [key, "[redacted]"];
    return [key, redactConnectorValue(item)];
  }));
}

function capabilities(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("manifest.capabilities must be an array");
    return;
  }
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const capability = record(item, `manifest.capabilities[${index}]`, errors);
    if (!capability) continue;
    const id = text(capability.id, `manifest.capabilities[${index}].id`, errors, 128, idPattern);
    if (id && ids.has(id)) errors.push(`manifest.capabilities[${index}].id is duplicated`);
    if (id) ids.add(id);
    if (!["inbound", "outbound", "read", "tool"].includes(String(capability.kind))) errors.push(`manifest.capabilities[${index}].kind is unsupported`);
    if (typeof capability.requires_authorization !== "boolean") errors.push(`manifest.capabilities[${index}].requires_authorization must be boolean`);
  }
}

function authRefs(value: unknown, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push("manifest.auth_refs must be an array");
    return;
  }
  for (const [index, item] of value.entries()) {
    const auth = record(item, `manifest.auth_refs[${index}]`, errors);
    if (!auth) continue;
    if (auth.kind !== "secret_ref") errors.push(`manifest.auth_refs[${index}].kind must be secret_ref`);
    text(auth.ref, `manifest.auth_refs[${index}].ref`, errors, 4096);
    if (containsSecretValue(auth.ref)) errors.push(`manifest.auth_refs[${index}].ref must be an opaque reference`);
  }
}

function audit(value: unknown, errors: string[]): void {
  const item = record(value, "audit", errors);
  if (!item) return;
  text(item.action_id, "audit.action_id", errors, 256);
  text(item.correlation_id, "audit.correlation_id", errors, 256);
  text(item.event_ref, "audit.event_ref", errors, 4096);
  text(item.idempotency_key, "audit.idempotency_key", errors, 256);
  text(item.occurred_at, "audit.occurred_at", errors, 64);
}

function cursor(value: unknown, connectorID: unknown, errors: string[]): void {
  if (value === undefined) return;
  const item = record(value, "inbound.cursor", errors);
  if (!item) return;
  const id = text(item.connector_id, "inbound.cursor.connector_id", errors, 128, idPattern);
  text(item.position, "inbound.cursor.position", errors, 4096);
  text(item.scope, "inbound.cursor.scope", errors, 256);
  if (id && typeof connectorID === "string" && id !== connectorID.trim()) errors.push("inbound.cursor.connector_id must match inbound.connector_id");
}

function authorization(value: unknown, errors: string[]): void {
  const item = record(value, "outbound.authorization", errors);
  if (!item) return;
  if (item.authority !== "deterministic_policy" && item.authority !== "human_approval") {
    errors.push("outbound.authorization.authority is not trusted");
  }
  if (item.decision !== "allow") errors.push("outbound.authorization.decision must be allow");
  text(item.action_gate_ref, "outbound.authorization.action_gate_ref", errors, 4096);
}

function payload(value: unknown, label: string, errors: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) errors.push(`${label} must be an object`);
}

function connectorMatch(value: unknown, manifest: ConnectorManifest, errors: string[]): void {
  if (value !== manifest.id) errors.push("envelope connector_id does not match manifest.id");
}

function record(value: unknown, label: string, errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, errors: string[], maximum: number, pattern?: RegExp, redact = false): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} is required`);
    return "";
  }
  const output = value.trim();
  if (output.length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
  if (pattern && !pattern.test(output)) errors.push(`${label} is invalid`);
  if (redact && output !== redactSensitiveText(output)) errors.push(`${label} contains a secret`);
  return output;
}

function optionalSafeText(value: unknown, label: string, errors: string[], maximum: number): void {
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return;
  }
  const output = value.trim();
  if (output.length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
  if (output !== redactSensitiveText(output)) errors.push(`${label} contains a secret`);
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function containsSecretValue(value: unknown): boolean {
  return typeof value === "string" && /(?:bearer\s+|api[_-]?key=|token=|secret=)/i.test(value);
}

function result(errors: string[]): ConnectorConformanceResult {
  return { errors, ok: errors.length === 0 };
}

const idPattern = /^[a-z0-9][a-z0-9_.:-]*$/;
const secretKey = /(?:token|secret|password|api[_-]?key|authorization)/i;
