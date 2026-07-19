import type { RunnerDatabase } from "../db/database.ts";
import type { PiNotificationIntent } from "../db/repositories/pi.ts";
import {
  runAgentCommunicationGatewayOnce,
  type AgentCommunicationGatewayResult
} from "./agentCommunicationGateway.ts";

export async function flushAgentCommunicationTestMessages(
  database: RunnerDatabase,
  message?: string
): Promise<AgentCommunicationGatewayResult> {
  return runAgentCommunicationGatewayOnce(database, {
    decide: async ({ intents }) => ({
      decision: "send",
      message: message ?? intents.map(contentSeed).filter(Boolean).join("\n\n"),
      rationale: "test Agent selected the staged safe content"
    })
  });
}

function contentSeed(intent: PiNotificationIntent): string {
  try {
    const payload = JSON.parse(intent.payload_json) as {
      agent_communication?: { content_seed?: unknown };
    };
    return typeof payload.agent_communication?.content_seed === "string"
      ? payload.agent_communication.content_seed
      : intent.summary;
  } catch {
    return intent.summary;
  }
}
