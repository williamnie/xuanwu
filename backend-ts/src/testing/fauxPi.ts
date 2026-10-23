import { afterEach } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { RunnerDatabase } from "../db/database.ts";
import { FIXTURE_TIME } from "./harness.ts";

/** Scripted PI model plumbing: a faux pi-ai provider wired to a test database's runner-default agent. */

export type FauxPi = ReturnType<typeof registerFauxProvider>;
export type FauxPiOptions = Omit<NonNullable<Parameters<typeof registerFauxProvider>[0]>, "api" | "provider"> & {
  /** The pi_agents row to point at the faux model. */
  agentId?: string;
  /** Fixed provider name for tests that assert on it; unique names are generated otherwise. */
  provider?: string;
};

/** Writes the models.json through which the PI runtime resolves `provider` to the faux model. */
export function writeFauxModelsConfig(
  db: RunnerDatabase,
  provider: string,
  { api = `${provider}-api`, model = {} }: { api?: string; model?: Record<string, unknown> } = {}
): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { [provider]: { api, apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1", ...model }] } }
  }));
}

/** Points a PI agent (runner-default unless named) at the faux `provider` and writes its models config. */
export function configureFauxAgent(db: RunnerDatabase, provider: string, agentId = "runner-default"): void {
  db.sqlite.run(
    `update pi_agents set model_provider=?, model_id='faux-1', thinking_level='off', enabled=1, updated_at=? where id=?`,
    [provider, FIXTURE_TIME, agentId]
  );
  writeFauxModelsConfig(db, provider);
}

/**
 * Returns `fauxPi(db)`: registers a faux model provider, points a PI agent of the database at it and unregisters it
 * after each test of the calling file.
 */
export function useFauxPi(prefix = "pi-faux"): (db: RunnerDatabase, options?: FauxPiOptions) => FauxPi {
  const registered: FauxPi[] = [];
  let count = 0;
  afterEach(() => {
    for (const faux of registered.splice(0)) faux.unregister();
  });
  return (db, { agentId, provider = `${prefix}-${++count}`, ...options } = {}) => {
    const faux = registerFauxProvider({ ...options, api: `${provider}-api`, provider });
    registered.push(faux);
    configureFauxAgent(db, provider, agentId);
    return faux;
  };
}
