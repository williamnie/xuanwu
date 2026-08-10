import type { RunnerDatabase } from "../db/database.ts";
import {
  dispatchImOutbox,
  type ImOutboxDispatchResult
} from "../pi/imReplyOutboxDispatcher.ts";
import type { FeishuConnectorConfig } from "./feishuTypes.ts";
import { createFeishuChannelConnector } from "./feishuChannelConnector.ts";
import type { FeishuMessageClient } from "./feishuClient.ts";

export type FeishuMessageSender = FeishuMessageClient;
export type FeishuOutboxDispatchResult = ImOutboxDispatchResult;

/** Bounded W1 adapter; all claim/send/receipt work stays in dispatchImOutbox. */
export function dispatchFeishuOutbox(options: {
  config: FeishuConnectorConfig;
  database: RunnerDatabase;
  limit?: number;
  now?: Date;
  sender: FeishuMessageSender;
}): Promise<FeishuOutboxDispatchResult> {
  const connector = createFeishuChannelConnector({ config: options.config, sender: options.sender });
  return dispatchImOutbox({
    database: options.database,
    limit: options.limit,
    now: options.now,
    resolveConnector: (source) => {
      if (source !== "feishu") throw new Error(`im channel module is not registered: ${source}`);
      return connector;
    },
    source: "feishu"
  });
}
