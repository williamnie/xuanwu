import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import {
  getConnectorCursor,
  recordConnectorUpdateAudit,
  saveConnectorCursor
} from "../db/repositories/connectorRuntime.ts";
import type { EventBus } from "../events/bus.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { ingestImInboundEnvelope } from "./imInboundService.ts";
import type { ImReceiverStatus } from "./imChannelContracts.ts";
import { TELEGRAM_CONNECTOR_ID } from "./telegramChannelConnector.ts";
import { createTelegramBotClient, TelegramClientError, type TelegramBotClient } from "./telegramClient.ts";
import { telegramConnectorStatus } from "./telegramConfig.ts";
import { normalizeTelegramMessageUpdate, telegramRawEventRef, type TelegramNormalizedMessage } from "./telegramEvents.ts";
import {
  resolveTelegramInteraction,
  type TelegramInteractionResultPresenter,
  type TelegramProjectSelectionResolver
} from "./telegramInteractionAdapter.ts";
import type { TelegramBotIdentity, TelegramConnectorConfig, TelegramUpdate } from "./telegramTypes.ts";

export type TelegramInboundHandler = (input: {
  externalEventId: number;
  normalized: TelegramNormalizedMessage;
  update: TelegramUpdate;
}) => Promise<void> | void;

type Options = {
  bus?: EventBus;
  client?: TelegramBotClient;
  clientFactory?: (config: TelegramConnectorConfig) => TelegramBotClient;
  database: RunnerDatabase;
  onMessage?: TelegramInboundHandler;
  presentInteractionResult?: TelegramInteractionResultPresenter;
  projectSelection?: TelegramProjectSelectionResolver;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  retryBaseMs?: number;
};

const CURSOR_SCOPE = "bot-updates";
const ALLOWED_UPDATES = ["message", "callback_query", "edited_message"];

export function createTelegramReceiverManager(options: Options) {
  let abort: AbortController | undefined;
  let client: TelegramBotClient | undefined;
  let generation = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let currentConfig: TelegramConnectorConfig | undefined;
  let botCache: { expiresAt: number; identity: TelegramBotIdentity; tokenKey: string } | undefined;
  let status: ImReceiverStatus = disabledStatus();

  async function restart(config: TelegramConnectorConfig): Promise<void> {
    stop();
    currentConfig = config;
    if (!telegramConnectorStatus(config).enabled) return;
    const expected = generation;
    status = { ...status, state: "connecting" };
    client = options.client ?? options.clientFactory?.(config) ?? createTelegramBotClient({ config });
    try {
      const identity = await getBotIdentity(client, config);
      const webhook = await client.getWebhookInfo({ signal: abortSignal(expected) });
      if (webhook.url.trim() !== "") {
        throw new TelegramClientError("Telegram webhook is configured; long polling requires an empty webhook URL", { kind: "permanent", status: 409 });
      }
      if (expected !== generation) return;
      status = { ...status, connected: true, last_error: "", state: "connected" };
      schedulePoll(expected, identity, 0);
    } catch (error) {
      if (expected !== generation) return;
      handlePollFailure(error, expected);
    }
  }

  function stop(): void {
    generation += 1;
    abort?.abort();
    abort = undefined;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    client = undefined;
    status = disabledStatus();
  }

  function schedulePoll(expected: number, identity: TelegramBotIdentity, delayMs: number): void {
    if (expected !== generation || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (expected !== generation) return;
      void pollOnce(expected, identity);
    }, Math.max(0, delayMs));
  }

  async function pollOnce(expected: number, identity: TelegramBotIdentity): Promise<void> {
    if (expected !== generation || !client || !currentConfig) return;
    abort = new AbortController();
    try {
      const cursor = getConnectorCursor(options.database, TELEGRAM_CONNECTOR_ID, CURSOR_SCOPE);
      const offset = cursor ? safeOffset(cursor.position) + 1 : undefined;
      const updates = await client.getUpdates({
        allowedUpdates: ALLOWED_UPDATES,
        ...(offset === undefined ? {} : { offset }),
        signal: abort.signal,
        timeoutSeconds: currentConfig.pollTimeoutSeconds
      });
      if (expected !== generation) return;
      for (const update of [...updates].sort((left, right) => left.update_id - right.update_id)) {
        if (expected !== generation) return;
        await processUpdate(update, identity, client, currentConfig);
      }
      status = { ...status, connected: true, last_error: "", reconnect_attempts: 0, state: "connected" };
      schedulePoll(expected, identity, 0);
    } catch (error) {
      if (expected !== generation || abort?.signal.aborted) return;
      handlePollFailure(error, expected, identity);
    } finally {
      abort = undefined;
    }
  }

  async function processUpdate(
    update: TelegramUpdate,
    identity: TelegramBotIdentity,
    telegramClient: TelegramBotClient,
    config: TelegramConnectorConfig
  ): Promise<void> {
    const updateId = updateID(update.update_id);
    const stored = getConnectorCursor(options.database, TELEGRAM_CONNECTOR_ID, CURSOR_SCOPE);
    if (stored && safeOffset(stored.position) >= update.update_id) return;
    if (update.edited_message) return processEditedUpdate(update, updateId, identity, config);
    if (update.callback_query) {
      const result = await resolveTelegramInteraction({
        bus: options.bus,
        callback: update.callback_query,
        client: telegramClient,
        config,
        database: options.database,
        presentResult: options.presentInteractionResult,
        projectSelection: options.projectSelection,
        providers: options.providers
      });
      if (["resolution_in_progress", "resolution_lost", "resolver_unavailable"].includes(result.reason)) {
        throw new TelegramClientError(`Telegram interaction ${result.reason}`, { kind: "transient" });
      }
      status = { ...status, last_event_at: new Date().toISOString() };
      return commitCursor(updateId, "callback", result.reason);
    }
    if (!update.message) return commitCursor(updateId, "ignored", "unsupported_update");
    let normalized: TelegramNormalizedMessage;
    try {
      normalized = normalizeTelegramMessageUpdate({ bot: identity, config, database: options.database, update });
    } catch (error) {
      if (errorKind(error) !== "permanent") throw error;
      return commitCursor(updateId, "rejected", safeError(error));
    }
    const forwarded = normalized.attention.decision !== "ignore";
    const event = options.database.transaction(() => {
      const ingested = ingestImInboundEnvelope(options.database, normalized.envelope, {
        raw: { raw_payload_ref: telegramRawEventRef(update) },
        status: normalized.attention.decision === "ignore" ? "ignored" : "unassigned",
        summary: {
          attention_action: normalized.attention.decision,
          attention_reason: normalized.attention.reason,
          conversation_id: normalized.message.conversation.id,
          message_id: normalized.message.message_id
        }
      });
      recordConnectorUpdateAudit(options.database, {
        connectorId: TELEGRAM_CONNECTOR_ID,
        outcome: normalized.attention.decision === "ignore" ? "ignored" : "accepted",
        reason: normalized.attention.reason,
        updateId
      });
      saveConnectorCursor(options.database, { connectorId: TELEGRAM_CONNECTOR_ID, position: updateId, scope: CURSOR_SCOPE });
      return ingested;
    }).immediate();
    status = { ...status, last_event_at: new Date().toISOString() };
    if (!forwarded) return;
    await options.onMessage?.({ externalEventId: event.id, normalized, update });
  }

  function commitCursor(
    updateId: string,
    outcome: "callback" | "edited" | "ignored" | "rejected",
    reason: string
  ): void {
    options.database.transaction(() => {
      recordConnectorUpdateAudit(options.database, { connectorId: TELEGRAM_CONNECTOR_ID, outcome, reason, updateId });
      saveConnectorCursor(options.database, { connectorId: TELEGRAM_CONNECTOR_ID, position: updateId, scope: CURSOR_SCOPE });
    }).immediate();
  }

  function processEditedUpdate(
    update: TelegramUpdate,
    updateId: string,
    identity: TelegramBotIdentity,
    config: TelegramConnectorConfig
  ): void {
    let normalized: TelegramNormalizedMessage;
    try {
      normalized = normalizeTelegramMessageUpdate({ bot: identity, config, database: options.database, edited: true, update });
    } catch (error) {
      if (errorKind(error) !== "permanent") throw error;
      return commitCursor(updateId, "rejected", safeError(error));
    }
    options.database.transaction(() => {
      ingestImInboundEnvelope(options.database, normalized.envelope, {
        raw: { raw_payload_ref: telegramRawEventRef(update) },
        status: "ignored",
        summary: {
          attention_action: normalized.attention.decision,
          attention_reason: normalized.attention.reason,
          conversation_id: normalized.message.conversation.id,
          edited: true,
          message_id: normalized.message.message_id
        }
      });
      recordConnectorUpdateAudit(options.database, {
        connectorId: TELEGRAM_CONNECTOR_ID,
        outcome: "edited",
        reason: "edited_message_recorded_without_pi_replay",
        updateId
      });
      saveConnectorCursor(options.database, { connectorId: TELEGRAM_CONNECTOR_ID, position: updateId, scope: CURSOR_SCOPE });
    }).immediate();
    status = { ...status, last_event_at: new Date().toISOString() };
  }

  function handlePollFailure(error: unknown, expected: number, identity?: TelegramBotIdentity): void {
    const kind = errorKind(error);
    status = {
      ...status,
      connected: false,
      last_error: safeError(error),
      reconnect_attempts: status.reconnect_attempts + 1,
      state: kind === "auth" || kind === "permanent" ? "failed" : "reconnecting"
    };
    if (kind === "auth" || kind === "permanent" || expected !== generation) return;
    const base = Math.max(10, options.retryBaseMs ?? 1_000);
    const retryAfter = (error as { retryAfterSeconds?: unknown })?.retryAfterSeconds;
    const delay = typeof retryAfter === "number" && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(base * 2 ** Math.min(status.reconnect_attempts - 1, 6), 60_000);
    if (identity) schedulePoll(expected, identity, delay);
    else if (currentConfig) {
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (expected === generation && currentConfig) void restart(currentConfig);
      }, delay);
    }
  }

  async function getBotIdentity(telegramClient: TelegramBotClient, config: TelegramConnectorConfig): Promise<TelegramBotIdentity> {
    const tokenKey = tokenFingerprint(config.botToken);
    if (botCache && botCache.tokenKey === tokenKey && botCache.expiresAt > Date.now()) return botCache.identity;
    const identity = await telegramClient.getMe({ signal: abortSignal(generation) });
    botCache = { expiresAt: Date.now() + config.getMeCacheTtlSeconds * 1000, identity, tokenKey };
    return identity;
  }

  function abortSignal(expected: number): AbortSignal {
    abort?.abort();
    abort = new AbortController();
    if (expected !== generation) abort.abort();
    return abort.signal;
  }

  return { restart, status: () => ({ ...status }), stop };
}

function disabledStatus(): ImReceiverStatus {
  return {
    connector_id: TELEGRAM_CONNECTOR_ID,
    connected: false,
    last_error: "",
    last_event_at: "",
    reconnect_attempts: 0,
    state: "disabled"
  };
}

function errorKind(error: unknown): string {
  return typeof (error as { kind?: unknown })?.kind === "string" ? String((error as { kind: string }).kind) : "transient";
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function safeOffset(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Telegram cursor is invalid");
  return number;
}

function updateID(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TelegramClientError("Telegram update_id is invalid", { kind: "permanent" });
  return String(value);
}

function tokenFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
