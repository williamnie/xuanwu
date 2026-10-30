import type { RunnerDatabase } from "../../db/database.ts";
import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishu.ts";
import { type FeishuMessageClient } from "./feishuClient.ts";
import { type FeishuConversationClock } from "./feishuConversationRouting.ts";
import type { FeishuIngestResult } from "./feishuIngest.ts";
import type { ChannelConnector } from "../channelConnectorContracts.ts";

export type FeishuConversationRunner = (input: FeishuRunnerInput) => Promise<FeishuRunnerResult>;

export type FeishuRunnerInput = {
  conversationId: string;
  event: FeishuNormalizedMessageEvent;
  prompt: string;
  projectId: string;
  targetProjectId?: string;
  targetProjectSource?: string;
  targetIssueId?: number;
};

export type FeishuRunnerResult = {
  conversationId?: string;
  projectId?: string;
  targetProjectId?: string;
  text: string;
};

export type FeishuAgentBridgeOptions = {
  clock?: FeishuConversationClock;
  config: () => FeishuConnectorConfig;
  connector?: ChannelConnector;
  database: RunnerDatabase;
  runConversation?: FeishuConversationRunner;
  sender?: FeishuMessageClient;
};

export type FeishuBridgeHandleInput = { event: FeishuNormalizedMessageEvent; ingest: FeishuIngestResult };

export type FeishuBridgeHandleResult = { reason: string; replied: boolean };
