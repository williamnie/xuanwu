import { cleanString } from "../../util/values.ts";
import { IM_MESSAGE_SCHEMA_VERSION, IM_OUTBOUND_SCHEMA_VERSION } from "./imChannelContracts.model.ts";
import type { Conformance, ImOutboundPayloadV1, ImChannelModule } from "./imChannelContracts.model.ts";

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

export function validateConfigurationDescriptor(
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

export function requiredUriPart(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

export function record(value: unknown, label: string, errors: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object`);
    return null;
  }
  return value as Record<string, unknown>;
}

export function id(value: unknown, label: string, errors: string[]): void {
  const output = text(value, label, errors, 128);
  if (output && !/^[a-z0-9][a-z0-9_.:-]*$/.test(output)) errors.push(`${label} is invalid`);
}

export function text(value: unknown, label: string, errors: string[], maximum: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${label} is required`);
    return "";
  }
  const output = value.trim();
  if (output.length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
  return output;
}

export function optionalText(value: unknown, label: string, errors: string[], maximum: number): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    errors.push(`${label} must be a string`);
    return;
  }
  if (value.trim().length > maximum) errors.push(`${label} exceeds ${maximum} characters`);
}

export function result(errors: string[]): Conformance {
  return { errors, ok: errors.length === 0 };
}
