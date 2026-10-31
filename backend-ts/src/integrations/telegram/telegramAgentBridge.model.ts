import type { RunnerDatabase } from "../../db/database.ts";
import type { ChannelConnector } from "../channelConnectorContracts.ts";
import { type ImConversationPromptProjection } from "../im/imConversationContext.ts";
import { type ImConversationRoute } from "../im/imConversationRouting.ts";
import { type ImProjectContextResult } from "../im/imProjectContext.ts";
import type { TelegramInboundHandler } from "./telegramReceiver.ts";
import type { TelegramConnectorConfig } from "./telegramTypes.ts";

export type TelegramSupervisorConversation = (input: {
  channelContext: string;
  channelContextProjection?: ImConversationPromptProjection;
  conversationId: string;
  prompt: string;
  targetIssueId?: number;
  targetProjectId: string;
  targetProjectSource?: string;
  title: string;
}) => Promise<{ conversationId?: string; targetProjectId?: string; text: string }>;

export type Options = {
  config: () => TelegramConnectorConfig;
  connector: ChannelConnector;
  database: RunnerDatabase;
  runSupervisorConversation?: TelegramSupervisorConversation;
};

export type BridgeInput = Parameters<TelegramInboundHandler>[0];

export type RunResult = {
  conversationId?: string;
  kind: "reply" | "selection";
  projectContext: ImProjectContextResult;
  route: ImConversationRoute;
  targetIssueId?: number;
  targetProjectId?: string;
  text: string;
};
