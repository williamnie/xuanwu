import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { PiConversation } from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";

export function publishPiSessionEvent(
  bus: EventBus | undefined,
  conversation: PiConversation,
  event: AgentSessionEvent
): void {
  bus?.publish(piAppEvent(conversation, event));
}

function piAppEvent(conversation: PiConversation, event: AgentSessionEvent): AppEvent {
  return {
    type: "pi.conversation.event",
    conversationId: conversation.id,
    projectId: conversation.project_id,
    provider: "pi-sdk",
    agent_event_type: event.type,
    status: piEventStatus(event),
    text: piEventText(event),
    payload: JSON.stringify(piEventPayload(event)),
    created_at: new Date().toISOString()
  };
}

function piEventStatus(event: AgentSessionEvent): string {
  if (event.type === "agent_start") return "running";
  if (event.type === "agent_end") return event.willRetry ? "retrying" : "completed";
  if (event.type === "message_update" && event.message.errorMessage) return "failed";
  return "";
}

function piEventText(event: AgentSessionEvent): string {
  if (event.type === "message_update") {
    const assistantEvent = event.assistantMessageEvent;
    if ("delta" in assistantEvent) return assistantEvent.delta;
    if ("content" in assistantEvent) return assistantEvent.content;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    return collectTextContent(event.message.content);
  }
  return "";
}

function piEventPayload(event: AgentSessionEvent): Record<string, unknown> {
  const payload: Record<string, unknown> = { type: event.type };
  if (event.type === "message_start" || event.type === "message_end") payload.role = event.message.role;
  if (event.type === "message_update") {
    payload.role = event.message.role;
    payload.assistant_event_type = event.assistantMessageEvent.type;
  }
  if (isToolEvent(event)) {
    payload.tool_call_id = event.toolCallId;
    payload.tool_name = event.toolName;
  }
  if (event.type === "tool_execution_end") payload.is_error = event.isError;
  return payload;
}

function collectTextContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => (
      typeof block === "object" && block !== null &&
      "type" in block && block.type === "text" &&
      "text" in block && typeof block.text === "string"
    ))
    .map((block) => block.text)
    .join("\n");
}

type PiToolEvent = Extract<AgentSessionEvent, {
  type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
}>;

function isToolEvent(event: AgentSessionEvent): event is PiToolEvent {
  return ["tool_execution_start", "tool_execution_update", "tool_execution_end"].includes(event.type);
}
