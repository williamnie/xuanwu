import type { FeishuConnectorConfig, FeishuNormalizedMessageEvent } from "./feishuTypes.ts";
import { type ConnectorHealth, type InboundEnvelope } from "../channelConnectorContracts.ts";
import { type FeishuMessageClient } from "./feishuClient.ts";

export type FeishuConnectorInbound = {
  envelope: InboundEnvelope;
  event: FeishuNormalizedMessageEvent;
};

export type FeishuConnectorOptions = {
  config: FeishuConnectorConfig | (() => FeishuConnectorConfig);
  health?: () => ConnectorHealth;
  onInbound?: (envelope: InboundEnvelope) => Promise<void> | void;
  sender?: FeishuMessageClient;
};
