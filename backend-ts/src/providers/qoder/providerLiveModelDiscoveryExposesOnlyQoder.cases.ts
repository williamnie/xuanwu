import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { checkManifest } from "../core/conformance.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderEvent } from "../types.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import type { QoderSessionFunctions } from "./sessionHistory.ts";

import { qoderConfig, readyProbe, init, taskNotification, sdkResult, provider, sessionInfo, history, ConcurrentFacade } from "./providerTestFixtures.ts";

export function registerLiveModelDiscoveryExposesOnlyQoder() {
test("live model discovery exposes only Qoder metadata and constrains effort choices", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    fake.facade.listModels = async () => [{
      value: "performance",
      displayName: "Qoder Performance",
      description: "fixture",
      efforts: ["low", "high"],
      defaultEffort: "high",
      isDefault: true,
      isEnabled: true,
      priceFactor: 1.5
    }];

    await expect(provider(fake.facade).listModels()).resolves.toEqual([{
      creditsMultiplier: 1.5,
      defaultReasoningEffort: "high",
      displayName: "Qoder Performance",
      id: "performance",
      isDefault: true,
      model: "performance",
      source: "qoder_account_live",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      verified: true
    }]);
  });

test("failed discovery returns marked Qoder suggestions without Codex model leakage", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    fake.facade.listModels = async () => { throw new Error("QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"); };

    const models = await provider(fake.facade).listModels() as Array<Record<string, unknown>>;
    expect(models.map((model) => model.id)).toEqual(["auto", "ultimate", "performance", "efficient", "lite"]);
    expect(models.every((model) => model.verified === false && model.source === "static_suggestion")).toBe(true);
    expect(models.every((model) => model.warning === "账号模型发现失败；请从 Qoder 静态建议中选择")).toBe(true);
    expect(JSON.stringify(models)).not.toContain("fixture-secret");
    expect(JSON.stringify(models)).not.toMatch(/gpt-|codex-default/);
  });

test("multiple attempts do not re-add resume usage with unknown cumulative semantics", async () => {
    const initialEvents: ProviderEvent[] = [];
    const initial = createFakeQoderSdkFacade([init("resume-1"), sdkResult("resume-1", {
      usage: { ...sdkResult().usage, input_tokens: 100, output_tokens: 50, credits: 2 }
    })]);
    await provider(initial.facade, { session: "resume-1" }).run({
      issueId: 2,
      projectId: "p",
      cwd: "/fixture/project",
      prompt: "start",
      onEvent: (event) => initialEvents.push(event)
    });

    const resumedEvents: ProviderEvent[] = [];
    const resumed = createFakeQoderSdkFacade([init("resume-1"), sdkResult("resume-1", {
      total_credits: 9,
      usage: { ...sdkResult().usage, input_tokens: 100, output_tokens: 50, credits: 2 }
    })]);
    await provider(resumed.facade).recover({
      issueId: 2,
      projectId: "p",
      cwd: "/fixture/project",
      prompt: "continue",
      session: { provider: "qoder", sessionId: "resume-1" },
      onEvent: (event) => resumedEvents.push(event)
    });

    const initialTerminal = initialEvents.at(-1)!;
    const terminal = resumedEvents.at(-1)!;
    expect(initialTerminal.runEvent?.cost?.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    expect(terminal.runEvent?.cost).toBeUndefined();
    expect(terminal.runEvent?.metadata.usage_scope).toBe("resume_semantics_unverified");
    expect(terminal.raw?.payload).toMatchObject({
      usage_projection: {
        credits: {
          request: { provenance: "result.usage", value: 2 },
          session: { provenance: "result.total_credits", semantics: "session_cumulative_unverified", value: 9 }
        },
        money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" }
      }
    });
  });
}
