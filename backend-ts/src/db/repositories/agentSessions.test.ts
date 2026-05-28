import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getAgentSession, listAgentSessions, upsertAgentSession } from "./agentSessions.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-agent-sessions-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("agent session repository", () => {
  test("upserts provider-aware sessions and supports list/get", async () => {
    const db = await openFixtureDatabase();
    try {
      upsertAgentSession(db, {
        provider: "codex",
        provider_session_id: "thread-1",
        project_id: "demo",
        issue_id: 159,
        title: "Persist runtime",
        preview: "first preview",
        status: "running",
        raw_ref: { provider_turn_id: "turn-1" }
      });
      upsertAgentSession(db, {
        provider: "codex",
        provider_session_id: "thread-1",
        preview: "updated preview",
        status: "completed"
      });
      upsertAgentSession(db, {
        provider: "fake-execution-only",
        provider_session_id: "session-2",
        project_id: "demo",
        issue_id: 160
      });

      expect(getAgentSession(db, "codex:thread-1")).toMatchObject({
        session_key: "codex:thread-1",
        provider: "codex",
        provider_session_id: "thread-1",
        project_id: "demo",
        issue_id: 159,
        title: "Persist runtime",
        preview: "updated preview",
        status: "completed",
        raw_ref: "{\"provider_turn_id\":\"turn-1\"}"
      });
      expect(getAgentSession(db, "missing")).toBeNull();
      expect(listAgentSessions(db, { provider: "codex" }).map((session) => session.session_key)).toEqual([
        "codex:thread-1"
      ]);
      expect(listAgentSessions(db, { projectId: "demo" }).map((session) => session.session_key).sort()).toEqual([
        "codex:thread-1",
        "fake-execution-only:session-2"
      ]);
    } finally {
      db.close();
    }
  });
});
