import { type ChannelConnector, type ConnectorDeliveryReceipt, type OutboundEnvelope } from "../channelConnectorContracts.ts";
import type { id, text } from "./imChannelContracts.validation.ts";

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

export type Conformance = { errors: string[]; ok: boolean };
