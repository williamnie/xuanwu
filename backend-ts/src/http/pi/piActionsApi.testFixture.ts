import { type RunnerDatabase } from "../../db/database.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../../providers/types.ts";
import { registerPiActionRoutes } from "./piActionsApi.ts";
import { createRouter, type Router } from "../router.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

  function batchItem(ref: string, title: string) {
    return {
      acceptance_criteria: [`${title} 可独立验收。`],
      description: `${title} 的单一交付目标。`,
      evidence: [`PRD 要求 ${title}。`],
      proposed_changes: [`实施 ${title}。`],
      ref,
      title,
      validation: [`运行 ${ref} focused test。`]
    };
  }

  function postAction(
    router: Router,
    id: string,
    action: "approve" | "execute" | "reject"
  ): Promise<Response> {
    return router.handle(new Request(`${BASE_URL}/api/pi/actions/${id}/${action}`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    }));
  }

  function createPiActionsRouter(
    database: RunnerDatabase,
    provider: ExecutorProvider,
    kickedProjects: string[]
  ): Router {
    const router = createRouter();
    registerPiActionRoutes(router, {
      database,
      providers: { codex: provider },
      startProjectLoop: (_runtime, projectID) => kickedProjects.push(projectID)
    });
    return router;
  }

  function insertAgentProfile(db: RunnerDatabase, id: string): void {
    db.sqlite.run(
      `insert into agent_profiles (id, name, provider, model, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
      [id, id, "codex", "gpt-test", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
  }

  function insertProject(db: RunnerDatabase, id: string, options: { autoRun?: number } = {}): void {
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, provider_config_json, auto_run, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', options.autoRun ?? 0, 1,
        "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
  }

  function insertIssue(db: RunnerDatabase, projectID: string, patch: Record<string, string> = {}): number {
    db.sqlite.run(
      `insert into issues (project_id, title, status, error, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
      [projectID, "Queue me", patch.status ?? "triage", patch.error ?? "", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
    if (!row) throw new Error("missing issue id");
    return row.id;
  }

  function insertAgentSession(db: RunnerDatabase, projectID: string, sessionKey: string, turnID: string): void {
    const [, sessionID] = sessionKey.split(":");
    db.sqlite.run(
      `insert into agent_sessions
      (session_key, provider, provider_session_id, project_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionKey,
        "codex",
        sessionID,
        projectID,
        "Thread 1",
        "running",
        JSON.stringify({ provider_turn_id: turnID }),
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z"
      ]
    );
  }

  function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
    return db.sqlite.query<{ payload: string; type: string }, []>(
      "select type, payload from issue_events order by id asc"
    ).all();
  }

  function mustGetProject(db: RunnerDatabase, id: string): Project {
    const project = getProject(db, id);
    if (!project) throw new Error("missing project");
    return project;
  }

  class SessionSteerProvider implements ExecutorProvider {
    readonly capabilities = ["resume_session"] as const;
    readonly calls: Record<string, unknown>[] = [];
    readonly id = "codex" as const;
  
    async run(_input: ProviderRunInput): Promise<never> {
      throw new Error("not implemented");
    }
  
    async sendSessionMessage(input: SessionMessageInput) {
      this.calls.push({
        mode: input.mode,
        prompt: input.prompt,
        sessionId: input.sessionId,
        turnId: input.turnId
      });
      return {
        provider: "codex" as const,
        provider_session_id: input.sessionId,
        sessionId: input.sessionId,
        turn_id: "turn-steered"
      };
    }
  }

  class KickObserverProvider implements ExecutorProvider {
    readonly capabilities = ["issue_execution"] as const;
    readonly id = "codex" as const;
    readonly inputs: ProviderRunInput[] = [];
  
    async run(input: ProviderRunInput) {
      this.inputs.push(input);
      return { runId: `unexpected-${input.issueId}` };
    }
  }
  return { BASE_URL, openFixtureDatabase, batchItem, postAction, createPiActionsRouter, insertAgentProfile, insertProject, insertIssue, insertAgentSession, listEvents, mustGetProject, SessionSteerProvider, KickObserverProvider };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
