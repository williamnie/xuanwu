import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COLD_START_BUDGETS,
  summarizeColdStartSamples,
  type ColdStartSample
} from "./coldStart.ts";

describe("cold-start memory benchmark", () => {
  test("keeps the MEM-01 RSS and drift budgets explicit", () => {
    expect(COLD_START_BUDGETS).toEqual({
      idle_rss_p95_bytes: 256 * 1024 * 1024,
      idle_rss_drift_bytes: 32 * 1024 * 1024,
      warmup_seconds: 300,
      observation_seconds: 1800
    });
  });

  test("uses the larger API/ps reading and rejects either regression", () => {
    const passing = samples([220, 224, 232, 248]);
    expect(summarizeColdStartSamples(passing)).toEqual({
      samples: 4,
      rss_drift_bytes: 28 * 1024 * 1024,
      rss_p95_bytes: 248 * 1024 * 1024,
      within_budget: true
    });

    expect(summarizeColdStartSamples(samples([220, 221, 222, 257])).within_budget).toBe(false);
    expect(summarizeColdStartSamples(samples([210, 220, 230, 243])).within_budget).toBe(false);
  });

  test("keeps CLI, PI SDK, OAuth, and Supervisor runtimes off the idle static import chain", () => {
    const main = source("../main.ts");
    const core = source("../runtime/core.ts");
    const conversation = source("../http/piConversationApi.ts");
    const oauth = source("../http/piOAuthApi.ts");
    const supervisor = source("../pi/issueSupervisorDecision.ts");

    expect(main).not.toMatch(/^import \{ runCli \}/m);
    expect(main).not.toMatch(/^import \{ runPiConversationPrompt \}/m);
    expect(main).toContain('await import("./cli/command.ts")');
    expect(main).toContain('await import("./runtime/web.ts")');
    expect(main).toContain('await import("./runtime/core.ts")');
    expect(core).not.toMatch(/^import \{ runPiConversationPrompt \}/m);
    expect(core).toContain('await import("../http/piConversationApi.ts")');
    expect(conversation).not.toMatch(/^import \{[^}]*createPiRuntimeSession[^}]*\} from "\.\/piRuntime\.ts"/ms);
    expect(conversation).toContain('await import("./piRuntime.ts")');
    expect(oauth).not.toMatch(/^import \{ AuthStorage \} from "@earendil-works\/pi-coding-agent"/m);
    expect(oauth).toContain('await import("@earendil-works/pi-coding-agent")');
    expect(supervisor).not.toMatch(/^import \{ createPiRuntimeSession \}/m);
    expect(supervisor).toContain('await import("../http/piRuntime.ts")');
  });
});

function samples(mebibytes: number[]): ColdStartSample[] {
  return mebibytes.map((value, index) => ({
    api_rss_bytes: (value - 1) * 1024 * 1024,
    ps_rss_bytes: value * 1024 * 1024,
    sampled_at: new Date(index * 1000).toISOString()
  }));
}

function source(relativePath: string): string {
  return readFileSync(join(import.meta.dir, relativePath), "utf8");
}
