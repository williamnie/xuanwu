import { type PiNotificationIntent } from "../db/repositories/pi.ts";

export type AgentCommunicationDecision = {
  decision: "send" | "suppress";
  message: string;
  rationale: string;
};

export type AgentCommunicationDecisionInput = {
  intents: PiNotificationIntent[];
  now: Date;
};

export type AgentCommunicationDecider = (
  input: AgentCommunicationDecisionInput
) => Promise<AgentCommunicationDecision>;

export type AgentCommunicationGatewayResult = {
  fallback: number;
  failed: number;
  groups: number;
  intents: number;
  queued: number;
  suppressed: number;
};

export type CommunicationEnvelope = {
  approvalActionID: string;
  channel: string;
  contentSeed: string;
  notificationID: string;
  notificationType: string;
  target: { chatID: string; eventID: number; messageID: string; threadID: string };
};

export type AgentCommunicationFailure = {
  code: "agent_output_invalid" | "agent_unavailable";
  message: string;
};

export const DEFAULT_LIMIT = 50;
