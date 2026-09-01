import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { ChannelConnector, OutboundEnvelope } from "../integrations/channelConnectorContracts.ts";
import { feishuChannelConnectorManifest } from "../integrations/feishuChannelConnector.ts";
import { buildFeishuConnectorConfig } from "../integrations/feishuConfig.ts";
import { telegramChannelConnectorManifest } from "../integrations/telegramChannelConnector.ts";
import { buildTelegramConnectorConfig } from "../integrations/telegramConfig.ts";
import { createReleaseUpdateMonitor } from "./releaseUpdateMonitor.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];

afterEach(async () => {
  databases.splice(0).forEach((database) => database.close());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("release update monitor", () => {
  test("notifies every configured IM channel once per release version", async () => {
    const database = await testDatabase();
    const delivered: Array<{ channel: string; text: string }> = [];
    const connectors = new Map<string, ChannelConnector>([
      ["feishu", fakeConnector("feishu", delivered)],
      ["telegram", fakeConnector("telegram", delivered)]
    ]);
    const monitor = createReleaseUpdateMonitor({
      checkUpdate: async () => ({ current: "v1.0.0", latest: "v1.1.0", update_available: true }),
      database,
      feishuConfig: () => buildFeishuConnectorConfig({
        allowedChatIds: ["oc_release"],
        appId: "app",
        appSecret: "secret",
        defaultChatId: "oc_release"
      }),
      imChannels: { get: (id) => ({ connector: connectors.get(id)! }) },
      now: () => new Date("2026-09-01T00:00:00.000Z"),
      telegramConfig: () => buildTelegramConnectorConfig({
        allowedChatIds: ["-10001"],
        allowedUserIds: ["10001"],
        botToken: "token",
        defaultChatId: "-10001",
        enabled: true
      })
    });

    await monitor.checkNow();
    await monitor.checkNow();

    expect(delivered).toHaveLength(2);
    expect(delivered.map((item) => item.channel).sort()).toEqual(["feishu", "telegram"]);
    expect(delivered.every((item) => item.text.includes("v1.1.0") && item.text.includes("安全升级"))).toBe(true);
    expect(database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from external_links where external_type='release_update_available'"
    ).get()?.count).toBe(2);
    expect(database.sqlite.query<{ count: number }, []>(
      "select count(*) as count from sync_outbox where operation_kind='im_reply' and status='sent'"
    ).get()?.count).toBe(2);
  });

  test("does not send when no newer release exists", async () => {
    const database = await testDatabase();
    const delivered: Array<{ channel: string; text: string }> = [];
    const monitor = createReleaseUpdateMonitor({
      checkUpdate: async () => ({ current: "v1.1.0", latest: "v1.1.0", update_available: false }),
      database,
      feishuConfig: () => buildFeishuConnectorConfig(),
      imChannels: { get: () => ({ connector: fakeConnector("feishu", delivered) }) },
      telegramConfig: () => buildTelegramConnectorConfig()
    });
    await monitor.checkNow();
    expect(delivered).toEqual([]);
  });
});

function fakeConnector(channel: "feishu" | "telegram", delivered: Array<{ channel: string; text: string }>): ChannelConnector {
  const manifest = channel === "feishu" ? feishuChannelConnectorManifest() : telegramChannelConnectorManifest();
  return {
    manifest,
    deliver: async (envelope: OutboundEnvelope) => {
      const payload = envelope.payload as { text?: string };
      delivered.push({ channel, text: String(payload.text || "") });
      return { provider_request_ref: `${channel}-message`, replayed: false, target: envelope.target };
    }
  };
}

async function testDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-release-monitor-"));
  roots.push(root);
  const database = await openDatabase({ stateDir: root });
  databases.push(database);
  return database;
}
