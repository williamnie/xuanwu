import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config/env.ts";
import { claudeFactory } from "../providers/claude/factory.ts";
import { claudeProviderAppEvent } from "../providers/claude/provider.ts";
import type { AppEvent } from "../events/bus.ts";
import { codexFactory } from "../providers/codex/factory.ts";
import { reconcileStaleCodexProcessOwnership } from "../providers/codex/processLifecycle.ts";
import { createProviderRegistry, type ProviderRegistry } from "../providers/core/registry.ts";
import { piFactory } from "../providers/pi/factory.ts";
import { qoderFactory } from "../providers/qoder/factory.ts";

/**
 * 按与中心相同的环境变量配置启动本机 provider，但不打开数据库：
 * 会话命名、应用事件等依赖中心数据的旁路功能在节点上关闭。
 */
export async function startNodeProviders(
  appEventSink: (event: AppEvent) => void = () => {}
): Promise<{ registry: ProviderRegistry; stateDir: string }> {
  const config = loadConfig([]);
  await mkdir(config.stateDir, { recursive: true });
  const ownershipFile = join(config.stateDir, "node-codex-process-ownership.json");
  await reconcileStaleCodexProcessOwnership(ownershipFile);
  const registry = createProviderRegistry();
  // 审批请求与会话事件经节点送回中心总线（前端会话页、飞书审批通知依赖它们）。
  if (config.providers.codex) registry.registerFactory(codexFactory({ appEventSink, ownershipFile }));
  if (config.providers.claude) registry.registerFactory(claudeFactory({ eventSink: (event) => appEventSink(claudeProviderAppEvent(event)) }));
  if (config.providers["pi-coding-agent"]) {
    registry.registerFactory(piFactory({ command: config.providers["pi-coding-agent"].command ?? "pi" }));
  }
  if (config.providers.qoder) registry.registerFactory(qoderFactory({}));
  await registry.startConfigured(config.providers as Record<string, { enabled?: boolean } & Record<string, unknown>>);
  return { registry, stateDir: config.stateDir };
}
