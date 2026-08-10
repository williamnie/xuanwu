import {
  assertConnectorConformance,
  type ChannelConnector,
  type ConnectorCapability,
  type ConnectorDeliveryReceipt,
  type OutboundEnvelope
} from "./channelConnectorContracts.ts";

/**
 * Generic IM channel layer (design: 2026-08-02-generic-im-channel-telegram-design.md,
 * phase A). These contracts sit on top of the P09.01 ChannelConnector contract and
 * never replace it: `ChannelConnector.deliver(OutboundEnvelope)` stays the only
 * production send entry point, and provider transport clients/card JSON stay
 * private to the channel module.
 */

export const IM_MESSAGE_SCHEMA_VERSION = "xuanwu.im-message.v1" as const;
export const IM_OUTBOUND_SCHEMA_VERSION = "xuanwu.im-outbound.v1" as const;
export const IM_DELIVERY_RECEIPT_SCHEMA_VERSION = "xuanwu.im-delivery-receipt.v1" as const;

/**
 * Provider-neutral capability vocabulary. `card.send` is intentionally absent:
 * presentation of interactions is provider-private (Feishu renders cards).
 */
export const IM_CAPABILITY_IDS = [
  "message.receive",
  "message.reply",
  "reaction.add",
  "interaction.send",
  "interaction.receive",
  "thread.reply"
] as const;
export type ImCapabilityId = typeof IM_CAPABILITY_IDS[number];

export type ImConversationKind = "direct" | "group" | "channel" | "unknown";

/**
 * Canonical inbound message. Every provider id is an opaque string; core code
 * never parses id prefixes (`oc_`/`ou_`/numeric) or guesses time units.
 */
export type ImInboundMessageV1 = {
  schema_version: typeof IM_MESSAGE_SCHEMA_VERSION;
  connector_id: string;
  update_id: string;
  message_id: string;
  conversation: { id: string; kind: ImConversationKind };
  thread?: { id: string; root_message_id?: string };
  sender: { id: string; display_name?: string; kind: "user" | "bot" | "chat" | "unknown"; open_id?: string };
  text: string;
  mentions: Array<{ id?: string; display_name?: string; is_self?: boolean }>;
  attachments: Array<{
    id: string;
    kind: "image" | "file" | "audio" | "video" | "other";
    name?: string;
    mime_type?: string;
    size_bytes?: number;
  }>;
  occurred_at: string;
  raw_event_ref: string;
};

/** Target ids are opaque strings. Core stores them verbatim. */
export type ImTargetV1 = {
  /** Opaque provider-owned addressing hint; core stores and forwards it only. */
  address_type?: string;
  connector_id: string;
  conversation_id: string;
  thread_id?: string;
  reply_to_message_id?: string;
  actor_id?: string;
};

export type ImInteractionActionV1 = {
  action_id: string;
  label: string;
  style: "primary" | "default" | "danger";
};

/**
 * Canonical interaction display model. It carries presentation only; the
 * callback must resolve through a server-side binding before any business
 * action runs (see ImInteractionService).
 */
export type ImInteractionV1 = {
  schema_version: "xuanwu.im-interaction.v1";
  interaction_id: string;
  kind: "choice" | "approval" | "confirmation";
  title: string;
  body: string;
  actions: ImInteractionActionV1[];
  expires_at: string;
  revision: number;
};

export type ImOutboundOperation = "message.reply" | "reaction.add" | "interaction.send";

/**
 * The only canonical outbound payload, carried inside the P09.01
 * OutboundEnvelope. `text` is normalized Markdown-safe business content;
 * presentation/escaping is the channel module's job.
 */
export type ImOutboundPayloadV1 = {
  schema_version: typeof IM_OUTBOUND_SCHEMA_VERSION;
  operation: ImOutboundOperation;
  target: ImTargetV1;
  text?: string;
  fallback_text?: string;
  reaction?: string;
  interaction?: ImInteractionV1;
  /** Provider-neutral business references (e.g. approval id), never transport secrets. */
  refs?: Record<string, string>;
};

export type ImDeliveryReceiptV1 = ConnectorDeliveryReceipt & {
  schema_version: typeof IM_DELIVERY_RECEIPT_SCHEMA_VERSION;
  connector_id: string;
  provider_message_refs: string[];
};

export type ImReceiverStatus = {
  connector_id: string;
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "failed";
  connected: boolean;
  reconnect_attempts: number;
  last_event_at: string;
  last_error: string;
};

/** Runtime-projection only: never persisted, never an authority for events/outbox. */
export interface ImReceiverAdapter {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  restart(): Promise<void> | void;
  status(): ImReceiverStatus;
}

/**
 * Presentation adapter: renders canonical outbound payloads into provider-ready
 * sends via the module-private connector. Application code never receives the
 * provider client.
 */
export interface ImPresentationAdapter {
  deliver(envelope: OutboundEnvelope): Promise<ConnectorDeliveryReceipt>;
}

/**
 * Provider transport clients are module-private: application code injects a
 * sender factory into the module at assembly time, and the module hands it to
 * its own connector. The registry never exposes senders.
 */
export type ImSenderFactory<TConfig, TSender> = (config: TConfig) => TSender;

export interface ImChannelModule {
  readonly callback?: {
    handle(request: Request): Promise<Response> | Response;
    path: string;
  };
  readonly configuration: {
    fields: Array<{
      id: string;
      kind: "boolean" | "enum" | "secret" | "string" | "string_list";
      label: string;
      options?: string[];
      required: boolean;
      write_only: boolean;
    }>;
    mode: "provider_specific" | "none";
    settings_path: string;
  };
  readonly id: string;
  readonly connector: ChannelConnector;
  readonly notifications?: {
    start(): Promise<void> | void;
    stop(): Promise<void> | void;
  };
  readonly receiver: ImReceiverAdapter;
  readonly presentation: ImPresentationAdapter;
}

/**
 * Extended internal surface of a module (not exposed through the registry):
 * HTTP route wiring, notification observers and sender factories stay
 * provider-owned so runtime/server assemble via the module instead of
 * scattering provider imports.
 */
export interface ImChannelModuleInternals<TConfig = unknown, TSender = unknown> {
  readonly module: ImChannelModule;
  readonly sender: ImSenderFactory<TConfig, TSender>;
  readonly onConfigChanged?: (config: TConfig) => Promise<void> | void;
}

export type ImChannelRegistryOptions = {
  /** Capability ids a module must declare to register (defaults: message.receive + message.reply for inbound modules). */
  require?: ImCapabilityId[];
};

type Conformance = { errors: string[]; ok: boolean };

export function validateImInboundMessage(value: unknown): Conformance {
  const errors: string[] = [];
  const message = record(value, "im inbound message", errors);
  if (!message) return result(errors);
  if (message.schema_version !== IM_MESSAGE_SCHEMA_VERSION) errors.push("im message schema_version is unsupported");
  id(message.connector_id, "im message connector_id", errors);
  text(message.update_id, "im message update_id", errors, 512);
  text(message.message_id, "im message message_id", errors, 512);
  const conversation = record(message.conversation, "im message conversation", errors);
  if (conversation) {
    text(conversation.id, "im message conversation.id", errors, 512);
    if (!["direct", "group", "channel", "unknown"].includes(String(conversation.kind))) {
      errors.push("im message conversation.kind is unsupported");
    }
  }
  if (message.thread !== undefined) {
    const thread = record(message.thread, "im message thread", errors);
    if (thread) {
      text(thread.id, "im message thread.id", errors, 512);
      optionalText(thread.root_message_id, "im message thread.root_message_id", errors, 512);
    }
  }
  const sender = record(message.sender, "im message sender", errors);
  if (sender) {
    text(sender.id, "im message sender.id", errors, 512);
    if (!["user", "bot", "chat", "unknown"].includes(String(sender.kind))) errors.push("im message sender.kind is unsupported");
  }
  if (typeof message.text !== "string") errors.push("im message text must be a string");
  if (!Array.isArray(message.mentions)) errors.push("im message mentions must be an array");
  if (!Array.isArray(message.attachments)) errors.push("im message attachments must be an array");
  text(message.occurred_at, "im message occurred_at", errors, 64);
  if (message.occurred_at && Number.isNaN(Date.parse(String(message.occurred_at)))) {
    errors.push("im message occurred_at must be ISO 8601");
  }
  text(message.raw_event_ref, "im message raw_event_ref", errors, 4096);
  return result(errors);
}

export function validateImTarget(value: unknown): Conformance {
  const errors: string[] = [];
  const target = record(value, "im target", errors);
  if (!target) return result(errors);
  id(target.connector_id, "im target connector_id", errors);
  text(target.conversation_id, "im target conversation_id", errors, 512);
  optionalText(target.thread_id, "im target thread_id", errors, 512);
  optionalText(target.reply_to_message_id, "im target reply_to_message_id", errors, 512);
  optionalText(target.actor_id, "im target actor_id", errors, 512);
  optionalText(target.address_type, "im target address_type", errors, 128);
  return result(errors);
}

export function validateImInteraction(value: unknown): Conformance {
  const errors: string[] = [];
  const interaction = record(value, "im interaction", errors);
  if (!interaction) return result(errors);
  if (interaction.schema_version !== "xuanwu.im-interaction.v1") errors.push("im interaction schema_version is unsupported");
  text(interaction.interaction_id, "im interaction interaction_id", errors, 256);
  if (!["choice", "approval", "confirmation"].includes(String(interaction.kind))) errors.push("im interaction kind is unsupported");
  text(interaction.title, "im interaction title", errors, 512);
  if (typeof interaction.body !== "string") errors.push("im interaction body must be a string");
  if (!Array.isArray(interaction.actions) || interaction.actions.length === 0) {
    errors.push("im interaction actions must be a non-empty array");
  } else {
    const ids = new Set<string>();
    for (const [index, action] of interaction.actions.entries()) {
      const item = record(action, `im interaction actions[${index}]`, errors);
      if (!item) continue;
      const actionId = text(item.action_id, `im interaction actions[${index}].action_id`, errors, 256);
      if (actionId && ids.has(actionId)) errors.push(`im interaction actions[${index}].action_id is duplicated`);
      if (actionId) ids.add(actionId);
      text(item.label, `im interaction actions[${index}].label`, errors, 256);
      if (!["primary", "default", "danger"].includes(String(item.style))) {
        errors.push(`im interaction actions[${index}].style is unsupported`);
      }
    }
  }
  text(interaction.expires_at, "im interaction expires_at", errors, 64);
  if (typeof interaction.revision !== "number" || !Number.isInteger(interaction.revision) || interaction.revision <= 0) {
    errors.push("im interaction revision must be a positive integer");
  }
  return result(errors);
}

export function validateImOutboundPayload(value: unknown): Conformance {
  const errors: string[] = [];
  const payload = record(value, "im outbound payload", errors);
  if (!payload) return result(errors);
  if (payload.schema_version !== IM_OUTBOUND_SCHEMA_VERSION) errors.push("im outbound payload schema_version is unsupported");
  if (!["message.reply", "reaction.add", "interaction.send"].includes(String(payload.operation))) {
    errors.push("im outbound payload operation is unsupported");
  }
  if (!validateImTarget(payload.target).ok) errors.push("im outbound payload target is invalid");
  if (payload.operation === "message.reply") {
    text(payload.text, "im outbound payload text", errors, 30_000);
  }
  if (payload.operation === "reaction.add") text(payload.reaction, "im outbound payload reaction", errors, 128);
  if (payload.operation === "interaction.send" && !validateImInteraction(payload.interaction).ok) {
    errors.push("im outbound payload interaction is invalid");
  }
  return result(errors);
}

/** Fail closed before handing a canonical payload to a channel module. */
export function assertImOutboundPayload(value: unknown): asserts value is ImOutboundPayloadV1 {
  const validation = validateImOutboundPayload(value);
  if (!validation.ok) throw new Error(`invalid im outbound payload: ${validation.errors.join("; ")}`);
}

/** Extract + validate the canonical payload carried by an OutboundEnvelope. */
export function imOutboundPayloadFromEnvelope(envelope: { operation: string; payload: Record<string, unknown> }): ImOutboundPayloadV1 {
  const payload = envelope.payload as unknown;
  assertImOutboundPayload(payload);
  const canonical = payload as ImOutboundPayloadV1;
  if (canonical.operation !== envelope.operation) {
    throw new Error("im outbound payload operation does not match envelope operation");
  }
  return canonical;
}

export function imDeliveryReceipt(input: {
  connector_id: string;
  provider_message_refs?: string[];
  provider_request_ref: string;
  target: string;
}): ImDeliveryReceiptV1 {
  return {
    connector_id: input.connector_id,
    provider_message_refs: [...(input.provider_message_refs ?? [input.provider_request_ref])],
    provider_request_ref: input.provider_request_ref,
    replayed: false,
    schema_version: IM_DELIVERY_RECEIPT_SCHEMA_VERSION,
    target: input.target
  };
}

/** Bounded, redaction-friendly serialization of a receipt for sync_outbox.result_json. */
export function imDeliveryReceiptResultJson(receipt: ImDeliveryReceiptV1): string {
  return JSON.stringify({
    connector_id: receipt.connector_id,
    provider_message_refs: receipt.provider_message_refs.slice(0, 16).map((ref) => ref.slice(0, 512)),
    provider_request_ref: receipt.provider_request_ref.slice(0, 512),
    schema_version: receipt.schema_version,
    target: receipt.target.slice(0, 4096)
  });
}

/**
 * Compile-time built-in registry. Registration is explicit; duplicate ids,
 * manifest mismatches and missing capabilities fail closed. The registry hands
 * out only the connector/presentation contracts — never provider clients.
 */
export function createImChannelRegistry(options: ImChannelRegistryOptions = {}) {
  const modules = new Map<string, ImChannelModule>();

  function register(module: ImChannelModule): void {
    if (!module || typeof module !== "object") throw new Error("im channel module is required");
    const id = cleanString(module.id);
    if (id === "") throw new Error("im channel module id is required");
    if (modules.has(id)) throw new Error(`im channel module is already registered: ${id}`);
    if (!module.connector || typeof module.connector !== "object") throw new Error(`im channel module ${id} is missing connector`);
    if (module.connector.manifest.id !== id) {
      throw new Error(`im channel module id ${id} does not match connector manifest id ${module.connector.manifest.id}`);
    }
    assertConnectorConformance(module.connector);
    for (const capability of options.require ?? []) {
      if (!declaresCapability(module.connector.manifest.capabilities, capability)) {
        throw new Error(`im channel module ${id} is missing required capability ${capability}`);
      }
    }
    if (!module.receiver || typeof module.receiver.status !== "function") {
      throw new Error(`im channel module ${id} is missing receiver`);
    }
    if (!module.presentation || typeof module.presentation.deliver !== "function") {
      throw new Error(`im channel module ${id} is missing presentation adapter`);
    }
    if (!module.configuration || !["none", "provider_specific"].includes(module.configuration.mode)) {
      throw new Error(`im channel module ${id} is missing configuration descriptor`);
    }
    if (module.configuration.mode === "provider_specific" && !module.configuration.settings_path.startsWith("/api/")) {
      throw new Error(`im channel module ${id} has invalid settings path`);
    }
    validateConfigurationDescriptor(id, module.configuration.fields);
    if (module.callback && !module.callback.path.startsWith("/api/integrations/")) {
      throw new Error(`im channel module ${id} has invalid callback path`);
    }
    modules.set(id, module);
  }

  function get(id: string): ImChannelModule {
    const module = modules.get(cleanString(id));
    if (!module) throw new Error(`im channel module is not registered: ${cleanString(id) || "(empty)"}`);
    return module;
  }

  function list(): ImChannelModule[] {
    return [...modules.values()];
  }

  return { get, has: (id: string) => modules.has(cleanString(id)), list, register };
}

function validateConfigurationDescriptor(
  connectorId: string,
  fields: ImChannelModule["configuration"]["fields"]
): void {
  if (!Array.isArray(fields)) throw new Error(`im channel module ${connectorId} is missing configuration fields`);
  const ids = new Set<string>();
  for (const field of fields) {
    const fieldId = cleanString(field?.id);
    if (fieldId === "" || ids.has(fieldId)) throw new Error(`im channel module ${connectorId} has invalid configuration field id`);
    ids.add(fieldId);
    if (cleanString(field.label) === "") throw new Error(`im channel module ${connectorId} has unlabeled configuration field ${fieldId}`);
    if (!["boolean", "enum", "secret", "string", "string_list"].includes(field.kind)) {
      throw new Error(`im channel module ${connectorId} has unsupported configuration field ${fieldId}`);
    }
    if (field.kind === "secret" && field.write_only !== true) {
      throw new Error(`im channel module ${connectorId} secret field ${fieldId} must be write-only`);
    }
    if (field.kind === "enum" && (!Array.isArray(field.options) || field.options.length === 0)) {
      throw new Error(`im channel module ${connectorId} enum field ${fieldId} requires options`);
    }
  }
}

export type ImChannelRegistry = ReturnType<typeof createImChannelRegistry>;

function declaresCapability(capabilities: ConnectorCapability[], id: ImCapabilityId): boolean {
  return capabilities.some((capability) => capability.id === id);
}

/** Canonical target URI codec. `receive_id_type` stays provider-owned. */
export function imTargetUri(target: ImTargetV1, receiveIDType: string): string {
  const connector = requiredUriPart(target.connector_id, "target connector_id");
  const type = requiredUriPart(receiveIDType, "target receive id type");
  const conversation = requiredUriPart(target.conversation_id, "target conversation_id");
  return `${encodeURIComponent(connector)}://${encodeURIComponent(type)}/${encodeURIComponent(conversation)}`;
}

/**
 * Build a P09.01 OutboundEnvelope carrying a canonical IM outbound payload.
 * The payload schema and the envelope operation always match (fail closed).
 */
export function createImOutboundEnvelope(input: {
  actionGateRef: string;
  actionID: string;
  authority: "deterministic_policy" | "human_approval";
  correlationID: string;
  eventRef: string;
  idempotencyKey: string;
  occurredAt?: string;
  payload: ImOutboundPayloadV1;
  target: string;
}): OutboundEnvelope {
  assertImOutboundPayload(input.payload);
  return {
    audit: {
      action_id: requiredUriPart(input.actionID, "actionID"),
      correlation_id: requiredUriPart(input.correlationID, "correlationID"),
      event_ref: requiredUriPart(input.eventRef, "eventRef"),
      idempotency_key: requiredUriPart(input.idempotencyKey, "idempotencyKey"),
      occurred_at: cleanString(input.occurredAt) || new Date().toISOString()
    },
    authorization: {
      action_gate_ref: requiredUriPart(input.actionGateRef, "actionGateRef"),
      authority: input.authority,
      decision: "allow"
    },
    connector_id: input.payload.target.connector_id,
    idempotency_key: requiredUriPart(input.idempotencyKey, "idempotencyKey"),
    operation: input.payload.operation,
    payload: input.payload as unknown as Record<string, unknown>,
    target: requiredUriPart(input.target, "target")
  };
}

/**
 * Registry-driven receiver lifecycle (design §5.7): each module has at most
 * one active receiver generation; health/status stay in-memory projections.
 */
export function createImReceiverRuntime(registry: ImChannelRegistry) {
  return {
    status(connectorId?: string): ImReceiverStatus[] {
      const modules = connectorId === undefined
        ? registry.list()
        : registry.has(connectorId) ? [registry.get(connectorId)] : [];
      return modules.map((module) => ({ ...module.receiver.status(), connector_id: module.id }));
    },
    async start(): Promise<void> {
      for (const module of registry.list()) {
        await module.notifications?.start();
        await module.receiver.start();
      }
    },
    async stop(): Promise<void> {
      for (const module of [...registry.list()].reverse()) {
        await module.receiver.stop();
        await module.notifications?.stop();
      }
    },
    async restart(connectorId: string): Promise<void> {
      await registry.get(connectorId).receiver.restart();
    }
  };
}

export type ImReceiverRuntime = ReturnType<typeof createImReceiverRuntime>;

function requiredUriPart(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function record(value: unknown, label: string, errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, label: string, errors: string[]): void {
  const output = text(value, label, errors, 128);
  if (output && !/^[a-z0-9][a-z0-9_.:-]*$/.test(output)) errors.push(`${label} is invalid`);
}

function text(value: unknown, label: string, errors: string[], maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} is required`);
    return "";
  }
  const output = value.trim();
  if (output.length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
  return output;
}

function optionalText(value: unknown, label: string, errors: string[], maximum: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return;
  }
  if (value.trim().length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
}

function result(errors: string[]): Conformance {
  return { errors, ok: errors.length === 0 };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
