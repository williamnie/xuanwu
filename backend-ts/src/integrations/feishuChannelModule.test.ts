import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/database.ts";
import type { FeishuConnectorConfig } from "./feishu.ts";
import { FEISHU_CONNECTOR_ID } from "./feishuChannelConnector.ts";
import { createFeishuChannelModule, createBuiltinImChannelRegistry } from "./feishuChannelModule.ts";
import { createImReceiverRuntime, createImChannelRegistry } from "./imChannelContracts.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function testConfig(overrides: Partial<FeishuConnectorConfig> = {}): FeishuConnectorConfig {
  return {
    allowedChatIds: [],
    allowedUserIds: [],
    appId: "",
    appSecret: "",
    defaultChatId: "",
    defaultProjectId: "",
    enabled: false,
    encryptKey: "",
    projectMappings: [],
    receiveMode: "websocket",
    verificationToken: "",
    ...overrides
  } as FeishuConnectorConfig;
}

describe("feishu im channel module", () => {
  test("module aggregates connector, receiver and presentation under one id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-module-test-"));
    try {
      const database = await openDatabase({ dbPath: join(dir, "runner.db"), stateDir: dir });
      try {
        const module = createFeishuChannelModule({
          config: () => testConfig(),
          database
        });
        expect(module.module.id).toBe(FEISHU_CONNECTOR_ID);
        expect(module.module.connector.manifest.id).toBe(FEISHU_CONNECTOR_ID);
        expect(module.module.receiver.status().connector_id).toBe(FEISHU_CONNECTOR_ID);
        expect(module.module.receiver.status().state).toBe("disabled");
        expect(typeof module.module.presentation.deliver).toBe("function");
        expect(typeof module.sender).toBe("function");
        expect(typeof module.onConfigChanged).toBe("function");
      } finally {
        database.close();
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("registry registers the feishu module and resolves the connector by source id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-module-test-"));
    try {
      const database = await openDatabase({ dbPath: join(dir, "runner.db"), stateDir: dir });
      try {
        const module = createFeishuChannelModule({
          config: () => testConfig(),
          database
        });
        const registry = createBuiltinImChannelRegistry({ feishu: module.module });
        expect(registry.has(FEISHU_CONNECTOR_ID)).toBe(true);
        expect(registry.get(FEISHU_CONNECTOR_ID).connector.manifest.capabilities
          .some((capability) => capability.id === "interaction.send")).toBe(true);
        expect(() => registry.register(module.module)).toThrow(/already registered/);
        expect(() => registry.get("telegram")).toThrow(/not registered/);
        const runtime = createImReceiverRuntime(registry);
        expect(runtime.status().map((status) => status.connector_id)).toEqual([FEISHU_CONNECTOR_ID]);
        expect(runtime.status(FEISHU_CONNECTOR_ID)[0]?.state).toBe("disabled");
        expect(runtime.status("telegram")).toEqual([]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  test("receiver runtime start/stop/restart drives the module receiver lifecycle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "im-module-test-"));
    try {
      const database = await openDatabase({ dbPath: join(dir, "runner.db"), stateDir: dir });
      try {
        const events: string[] = [];
        const module = createFeishuChannelModule({
          config: () => testConfig(),
          database
        });
        const registry = createImChannelRegistry();
        registry.register({
          ...module.module,
          receiver: {
            start: () => { events.push("start"); },
            stop: () => { events.push("stop"); },
            restart: () => { events.push("restart"); },
            status: () => module.module.receiver.status()
          }
        });
        const runtime = createImReceiverRuntime(registry);
        await runtime.start();
        await runtime.restart(FEISHU_CONNECTOR_ID);
        await runtime.stop();
        expect(events).toEqual(["start", "restart", "stop"]);
      } finally {
        database.close();
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
