import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";
import type { ExecutorProvider, InterruptInput, ProviderRunInput } from "../providers/types.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-session-interrupt-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun session interrupt API", () => {
  test("interrupts a persisted Codex session turn without mutating issues", async () => {
    const database = await openFixtureDatabase();
    const provider = new InterruptCaptureProvider();
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-manual",
        raw_ref: { provider_turn_id: "turn-manual" },
        status: "running"
      });

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-manual/interrupt`, { method: "POST" }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ interrupted: true });
      expect(provider.interrupts).toEqual([{
        session: { provider: "codex", sessionId: "thread-manual", turnId: "turn-manual" },
        reason: "session_interrupt"
      }]);
    } finally {
      database.close();
    }
  });
});

class InterruptCaptureProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["interrupt"] as const;
  readonly interrupts: InterruptInput[] = [];

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: InterruptInput): Promise<void> {
    this.interrupts.push(input);
  }
}
