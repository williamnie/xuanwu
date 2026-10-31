import { type RunnerDatabase } from "../../db/database.ts";
import { piManifest } from "../../providers/pi/factory.ts";
import { providerSessionDetail } from "../../providers/core/sessionView.ts";
import type { ExecutorProvider, InterruptInput, ProviderRunInput, ProviderRunResult, SessionMessageInput } from "../../providers/types.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const AUTH_TOKEN = "run-api-test-token";

  const openFixtureDatabase = useTestDatabase();

  class ControlProvider implements ExecutorProvider {
    readonly id = "codex" as const;
    readonly capabilities = ["issue_execution", "resume_session", "interrupt"] as const;
    readonly interrupts: InterruptInput[] = [];
    readonly messages: SessionMessageInput[] = [];
  
    async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
      throw new Error("not implemented");
    }
  
    async interrupt(input: InterruptInput): Promise<void> {
      this.interrupts.push(input);
    }
  
    async sendSessionMessage(input: SessionMessageInput) {
      this.messages.push(input);
      return {
        provider: "codex" as const,
        provider_session_id: input.sessionId,
        sessionId: input.sessionId,
        turn_id: "turn-resumed"
      };
    }
  }

  function insertProject(db: RunnerDatabase, id: string): void {
    db.sqlite.run(
      `insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
     values (?, ?, ?, 'codex', 0, ?, ?)`,
      [id, id, `/tmp/${id}`, timestamp(0), timestamp(0)]
    );
  }

  function insertIssue(db: RunnerDatabase, projectID: string, title: string, status: string): number {
    db.sqlite.run(
      `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
      [projectID, title, status, timestamp(0), timestamp(0)]
    );
    const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
    if (!row) throw new Error("missing inserted issue id");
    return row.id;
  }

  function insertRun(
    db: RunnerDatabase,
    issueID: number,
    status: string,
    input: { endedAt?: string; provider?: string; sessionID?: string; startedAt: string; turnID?: string }
  ): string {
    const id = `issue-${issueID}-attempt-1`;
    db.sqlite.run(
      `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
       started_at, ended_at, exit_reason, error)
     values (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        issueID,
        status,
        input.provider ?? "codex",
        input.sessionID ?? "",
        input.turnID ?? "",
        input.startedAt,
        input.endedAt ?? "",
        status === "done" ? "completed" : status === "failed" ? "provider failed" : "",
        status === "failed" ? "fixture failure" : ""
      ]
    );
    return `xw:run:issue_runs:${id}`;
  }

  class PiRunDetailProvider implements ExecutorProvider {
    readonly id = "pi-coding-agent" as const;
    readonly capabilities = ["issue_execution", "sessions"] as const;
    readonly manifest = piManifest();
  
    async run(_input: ProviderRunInput): Promise<ProviderRunResult> {
      throw new Error("not implemented");
    }
  
    async readSession(sessionId: string): Promise<Record<string, unknown>> {
      return providerSessionDetail(this.id, {
        sessionRef: sessionId,
        name: "Pi transcript",
        preview: "inspect run",
        cwd: "/tmp/demo",
        status: "idle",
        isRunning: false,
        createdAt: 1,
        updatedAt: 2,
        turns: [{ id: "turn-1", items: [
          { id: "user", type: "userMessage", content: [{ type: "input_text", text: "inspect run" }] },
          { id: "reasoning", type: "reasoning", content: [{ type: "text", text: "inspect" }] },
          { id: "answer", type: "agentMessage", text: "done" },
          { id: "tool", type: "custom_tool_call", name: "read", input: { path: "README.md" } },
          { id: "tool", type: "custom_tool_call_output", output: "contents", status: "completed" }
        ] }]
      });
    }
  }

  function audit(eventID: string, kind: string): Record<string, unknown> {
    return {
      actor: { id: `${kind}:fixture`, kind },
      correlation_id: `correlation:${eventID}`,
      event_id: eventID,
      occurred_at: "2026-07-16T00:00:00Z",
      reason: `control ${eventID}`
    };
  }

  function jsonRequest(path: string, body: unknown): Request {
    return new Request(`${BASE_URL}${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  }

  function authenticatedJsonRequest(path: string, body: unknown): Request {
    const request = jsonRequest(path, body);
    request.headers.set("authorization", `Bearer ${AUTH_TOKEN}`);
    return request;
  }

  function lifecycleEvents(db: RunnerDatabase, issueID: number, eventID: string): string[] {
    return db.sqlite.query<{ type: string }, [number, string]>(`
    select type from issue_events
    where issue_id=? and json_valid(payload) and json_extract(payload, '$.event_id')=?
    order by id asc
  `).all(issueID, eventID).map((row) => row.type);
  }

  function issueStatus(db: RunnerDatabase, issueID: number): string {
    return db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(issueID)?.status ?? "";
  }

  function timestamp(seconds: number): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
  }

  function insertTranscriptMessage(
    db: RunnerDatabase,
    issueID: number,
    runID: string,
    attemptID: string,
    seconds: number,
    itemID: string,
    phase: string,
    text: string
  ): void {
    db.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (?, 'issue.log', ?, ?)",
      [issueID, JSON.stringify({
        payload: { item_id: itemID, item_type: "agentMessage", phase },
        provider: "codex",
        raw_method: "item/completed",
        runtime_evidence_correlation: {
          attempt_id: attemptID,
          issue_run_id: runID.replace("xw:run:issue_runs:", ""),
          provider_session_id: "thread-transcript",
          provider_turn_id: "turn-transcript",
          run_id: runID
        },
        text,
        type: "raw"
      }), timestamp(seconds)]
    );
  }
  return { BASE_URL, AUTH_TOKEN, openFixtureDatabase, ControlProvider, insertProject, insertIssue, insertRun, PiRunDetailProvider, audit, jsonRequest, authenticatedJsonRequest, lifecycleEvents, issueStatus, timestamp, insertTranscriptMessage };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
