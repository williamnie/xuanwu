import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { feishuConnectorStatus, normalizeFeishuMessageEvent, type FeishuConnectorConfig } from "./feishu.ts";
import type { createFeishuAgentBridge } from "./feishuAgentBridge.ts";
import { projectSelectionCallbackAcceptedBody } from "./feishuCardCallbackResponse.ts";
import { ingestFeishuMessageEvent, publishFeishuAudit, rawPayloadRef } from "./feishuIngest.ts";
import { normalizeFeishuProjectSelectionAction } from "./feishuProjectSelection.ts";

export type FeishuReceiverStatus = {
  connected: boolean;
  last_error: string;
  last_event_at: string;
  receive_mode: "websocket" | "callback";
  reconnect_attempts: number;
  state: "disabled" | "connecting" | "connected" | "reconnecting" | "failed";
};

export type FeishuWsFactory = (input: {
  onCardAction: (event: unknown) => Promise<unknown>;
  config: FeishuConnectorConfig;
  onError: (error: unknown) => void;
  onMessage: (event: unknown) => Promise<void>;
  onReady: () => void;
  onReconnected: () => void;
  onReconnecting: () => void;
}) => FeishuWsClient | Promise<FeishuWsClient>;

type FeishuWsClient = {
  close(params?: { force?: boolean }): void;
  start(): Promise<void>;
  status?(): { reconnectAttempts?: number; state?: string };
};

type FeishuReceiverManagerOptions = {
  agentBridge?: ReturnType<typeof createFeishuAgentBridge>;
  bus?: EventBus;
  database: RunnerDatabase;
  wsFactory?: FeishuWsFactory;
};

const DISABLED_STATUS: FeishuReceiverStatus = {
  connected: false,
  last_error: "",
  last_event_at: "",
  receive_mode: "websocket",
  reconnect_attempts: 0,
  state: "disabled"
};

export function createFeishuReceiverManager(options: FeishuReceiverManagerOptions) {
  let client: FeishuWsClient | null = null;
  let status: FeishuReceiverStatus = { ...DISABLED_STATUS };

  async function restart(config: FeishuConnectorConfig): Promise<void> {
    stop();
    status = { ...DISABLED_STATUS, receive_mode: config.receiveMode };
    if (!shouldStart(config)) return;
    const factory = options.wsFactory ?? defaultFeishuWsFactory;
    status = { ...status, state: "connecting" };
    client = await factory({
      config,
      onCardAction: (event) => ingestCardAction(event, config),
      onError: (error) => fail(error),
      onMessage: (event) => ingest(event, config),
      onReady: () => connect(),
      onReconnected: () => connect(),
      onReconnecting: () => reconnect()
    });
    void client.start().catch((error) => fail(error));
  }

  function stop(): void {
    client?.close({ force: true });
    client = null;
  }

  function currentStatus(): FeishuReceiverStatus {
    const live = client?.status?.();
    return {
      ...status,
      reconnect_attempts: live?.reconnectAttempts ?? status.reconnect_attempts,
      state: normalizeState(live?.state, status.state)
    };
  }

  async function ingest(event: unknown, config: FeishuConnectorConfig): Promise<void> {
    status = { ...status, last_event_at: new Date().toISOString() };
    const rawRef = rawPayloadRef(event);
    try {
      const normalized = normalizeFeishuMessageEvent(event, { rawEventRef: rawRef });
      const result = ingestFeishuMessageEvent(event, receiverContext(config), {
        rawPayloadRef: rawRef,
        transport: "websocket"
      });
      await options.agentBridge?.handle({ event: normalized, ingest: result });
    } catch (error) {
      fail(error);
      publishFeishuAudit(receiverContext(config), {
        connector: "feishu",
        outcome: "rejected",
        raw_payload_ref: rawRef,
        reason: "websocket_event_rejected",
        transport: "websocket"
      });
    }
  }

  async function ingestCardAction(event: unknown, config: FeishuConnectorConfig): Promise<unknown> {
    status = { ...status, last_event_at: new Date().toISOString() };
    const rawRef = rawPayloadRef(event);
    const projectAction = normalizeFeishuProjectSelectionAction(event);
    if (!projectAction) return publishRejectedCardAction(config, rawRef);
    await options.agentBridge?.handleProjectSelectionAction(projectAction);
    return projectSelectionCallbackAcceptedBody();
  }

  function receiverContext(config: FeishuConnectorConfig) {
    return { bus: options.bus, config, database: options.database };
  }

  function connect(): void {
    status = { ...status, connected: true, last_error: "", state: "connected" };
  }

  function reconnect(): void {
    status = {
      ...status,
      connected: false,
      reconnect_attempts: status.reconnect_attempts + 1,
      state: "reconnecting"
    };
  }

  function fail(error: unknown): void {
    status = {
      ...status,
      connected: false,
      last_error: safeError(error),
      state: "failed"
    };
  }

  return { restart, status: currentStatus, stop };
}

export const defaultFeishuWsFactory: FeishuWsFactory = async (input) => {
  const Lark = await import("@larksuiteoapi/node-sdk");
  const dispatcher = new Lark.EventDispatcher({}).register({
    "card.action.trigger": async (data: unknown) => input.onCardAction(data),
    "im.message.receive_v1": async (data: unknown) => input.onMessage(data)
  });
  const wsClient = new Lark.WSClient({
    appId: input.config.appId,
    appSecret: input.config.appSecret,
    autoReconnect: true,
    loggerLevel: Lark.LoggerLevel.info,
    onError: (error: Error) => input.onError(error),
    onReady: input.onReady,
    onReconnected: input.onReconnected,
    onReconnecting: input.onReconnecting,
    source: "codex-issue-runner"
  });
  return {
    close: (params) => wsClient.close(params),
    start: () => wsClient.start({ eventDispatcher: dispatcher }),
    status: () => {
      const current = wsClient.getConnectionStatus();
      return { reconnectAttempts: current.reconnectAttempts, state: current.state };
    }
  };
};

function shouldStart(config: FeishuConnectorConfig): boolean {
  return config.receiveMode === "websocket" && feishuConnectorStatus(config).enabled === true;
}

function publishRejectedCardAction(config: FeishuConnectorConfig, rawRef: string): void {
  publishFeishuAudit({ config }, {
    connector: "feishu",
    outcome: "rejected",
    raw_payload_ref: rawRef,
    reason: "unsupported_card_action",
    transport: "websocket"
  });
}

function normalizeState(
  state: string | undefined,
  fallback: FeishuReceiverStatus["state"]
): FeishuReceiverStatus["state"] {
  if (state === "connected") return "connected";
  if (state === "connecting") return "connecting";
  if (state === "reconnecting") return "reconnecting";
  if (state === "failed") return "failed";
  return fallback;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
