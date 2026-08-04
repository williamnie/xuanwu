import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { getAgentSession, listAgentSessions, upsertAgentSession } from "./agentSessions.ts";

const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-agent-sessions-"));
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
      expect(listAgentSessions(db, { limit: 1, projectId: "demo" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("expresses PI and worker roles and filters sessions by role", async () => {
    const db = await openFixtureDatabase();
    try {
      upsertAgentSession(db, {
        provider: "pi-sdk",
        provider_session_id: "conv-1",
        agent_role: "pi_manager",
        project_id: "demo",
        title: "PI manager"
      });
      upsertAgentSession(db, {
        provider: "codex",
        provider_session_id: "thread-reviewer",
        agent_role: "reviewer",
        project_id: "demo",
        issue_id: 260
      });
      upsertAgentSession(db, {
        provider: "codex",
        provider_session_id: "thread-reporter",
        agent_role: "reporter",
        project_id: "demo"
      });

      expect(listAgentSessions(db, { role: "pi_manager" }).map((session) => session.session_key)).toEqual([
        "pi-sdk:conv-1"
      ]);
      expect(listAgentSessions(db, { projectId: "demo", role: "reviewer" })).toMatchObject([{
        agent_role: "reviewer",
        issue_id: 260,
        session_key: "codex:thread-reviewer"
      }]);
      expect(() => upsertAgentSession(db, {
        provider: "codex",
        provider_session_id: "thread-unknown",
        agent_role: "planner"
      })).toThrow("agent role 不合法");
    } finally {
      db.close();
    }
  });
});
