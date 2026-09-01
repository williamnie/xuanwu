import type { RunnerDatabase } from "../db/database.ts";
import { feishuConnectorStatus } from "../integrations/feishuConfig.ts";
import type { FeishuConnectorConfig } from "../integrations/feishuTypes.ts";
import type { ChannelConnector } from "../integrations/channelConnectorContracts.ts";
import { telegramConnectorStatus } from "../integrations/telegramConfig.ts";
import type { TelegramConnectorConfig } from "../integrations/telegramTypes.ts";
import { queueNotificationOutbox } from "../notifications/notificationOutbox.ts";
import { dispatchImOutbox } from "../pi/imReplyOutboxDispatcher.ts";
import {
  checkReleaseUpdate,
  defaultReleaseUpdaterPath,
  type ReleaseUpdateCheck
} from "./releaseUpdateCheck.ts";

const DEFAULT_INITIAL_DELAY_MS = 30_000;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const NOTIFICATION_TYPE = "release_update_available";

type ImChannels = { get(id: string): { connector: ChannelConnector } };

export type ReleaseUpdateMonitorOptions = {
  checkUpdate?: () => Promise<ReleaseUpdateCheck>;
  database: RunnerDatabase;
  enabled?: boolean;
  feishuConfig: () => FeishuConnectorConfig;
  imChannels: ImChannels;
  initialDelayMs?: number;
  intervalMs?: number;
  now?: () => Date;
  telegramConfig: () => TelegramConnectorConfig;
  updaterPath?: string;
};

export type ReleaseUpdateMonitor = {
  checkNow(): Promise<ReleaseUpdateCheck>;
  start(): void;
  stop(): void;
};

export function createReleaseUpdateMonitor(options: ReleaseUpdateMonitorOptions): ReleaseUpdateMonitor {
  const now = options.now ?? (() => new Date());
  const check = options.checkUpdate ?? (() => checkReleaseUpdate(options.updaterPath ?? defaultReleaseUpdaterPath()));
  const enabled = options.enabled ?? Bun.env.XUANWU_RELEASE_INSTALL === "1";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let inflight: Promise<ReleaseUpdateCheck> | undefined;

  const checkNow = async (): Promise<ReleaseUpdateCheck> => {
    if (inflight) return await inflight;
    inflight = (async () => {
      const result = await check();
      if (result.update_available) await notifyConfiguredChannels(options, result, now());
      return result;
    })();
    try {
      return await inflight;
    } finally {
      inflight = undefined;
    }
  };

  const schedule = (delay: number) => {
    if (stopped || !enabled) return;
    timer = setTimeout(async () => {
      try {
        await checkNow();
      } catch (error) {
        console.warn(JSON.stringify({ event: "release.update_check_failed", error: safeError(error) }));
      } finally {
        schedule(boundedDelay(options.intervalMs, DEFAULT_INTERVAL_MS));
      }
    }, delay);
  };

  return {
    checkNow,
    start: () => {
      if (timer || !enabled) return;
      stopped = false;
      schedule(boundedDelay(options.initialDelayMs, DEFAULT_INITIAL_DELAY_MS));
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}

async function notifyConfiguredChannels(
  options: ReleaseUpdateMonitorOptions,
  check: ReleaseUpdateCheck,
  now: Date
): Promise<void> {
  const routes = configuredRoutes(options.feishuConfig(), options.telegramConfig());
  const notificationID = `release_update:${check.latest}`;
  const content = releaseUpdateText(check);
  for (const route of routes) {
    try {
      const queued = queueNotificationOutbox(options.database, {
        channel: route.channel,
        content,
        createdBy: "release_update_monitor",
        notificationID,
        notificationType: NOTIFICATION_TYPE,
        target: { chatID: route.chatID }
      });
      if (queued.outboxID <= 0) continue;
      await dispatchImOutbox({
        database: options.database,
        now,
        outboxId: queued.outboxID,
        resolveConnector: (source) => options.imChannels.get(source).connector
      });
    } catch (error) {
      console.warn(JSON.stringify({
        channel: route.channel,
        event: "release.update_notification_failed",
        error: safeError(error),
        version: check.latest
      }));
    }
  }
}

function configuredRoutes(
  feishu: FeishuConnectorConfig,
  telegram: TelegramConnectorConfig
): Array<{ channel: "feishu" | "telegram"; chatID: string }> {
  const routes: Array<{ channel: "feishu" | "telegram"; chatID: string }> = [];
  if (feishuConnectorStatus(feishu).enabled === true) {
    const target = first(feishu.defaultChatId, feishu.defaultUserId, only(feishu.allowedChatIds), only(feishu.allowedUserIds));
    if (target) routes.push({ channel: "feishu", chatID: target });
  }
  if (telegramConnectorStatus(telegram).enabled) {
    const target = first(telegram.defaultChatId, only(telegram.allowedChatIds));
    if (target) routes.push({ channel: "telegram", chatID: target });
  }
  return routes;
}

function releaseUpdateText(check: ReleaseUpdateCheck): string {
  return [
    `玄武发现新版本 ${check.latest}（当前 ${check.current}）。`,
    "请打开 Runner 网页 → 设置 → 项目 → 安全升级。",
    "升级会先生成备份并完成隔离恢复演练，随后服务会短暂重启；失败时会恢复上一份 Release。"
  ].join("\n");
}

function first(...values: string[]): string {
  return values.map((value) => value.trim()).find(Boolean) ?? "";
}

function only(values: string[]): string {
  return values.length === 1 ? values[0]!.trim() : "";
}

function boundedDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error || "unknown error").slice(0, 240);
}
