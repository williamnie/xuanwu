import { expect, test } from "bun:test";
import type { ProviderEvent } from "../providers/types.ts";
import {
  RUN_COST_OBSERVATION_SCHEMA_VERSION,
  TOOL_OBSERVATION_SCHEMA_VERSION,
  createIssueLogPersistence
} from "./issueLogPersistence.ts";
import { session, costEvent } from "./issueLogPersistenceTestFixtures.ts";

export function registerIssueLogPersistenceReductionCases() {
  test("normal mode drops streaming protocol noise but keeps decisive events", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence(
      (event) => persisted.push(event),
      { mode: "normal" }
    );
    persistence.push({
      provider: "codex",
      type: "text",
      session,
      text: "streaming",
      raw: { method: "item/agentMessage/delta", payload: "streaming" }
    });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: { method: "turn/plan/updated", payload: "plan" }
    });
    persistence.push({
      provider: "codex",
      type: "raw",
      session,
      raw: {
        method: "item/completed",
        payload: JSON.stringify({ item: { id: "message-final", type: "agentMessage", text: "final" } })
      }
    });
    persistence.push({
      provider: "codex",
      type: "done",
      status: "completed",
      session,
      raw: { method: "turn/completed", payload: "completed" }
    });
    persistence.flush();

    expect(persisted.map((event) => event.raw?.method)).toEqual(["item/completed", "turn/completed"]);
    expect(persisted[0]).toMatchObject({ text: "final" });
  });

  test("normal mode stores every terminal command without semantic regex classification", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence(
      (event) => persisted.push(event),
      { mode: "normal" }
    );
    const commandCompleted = (id: string, command: string) => ({
      provider: "codex" as const,
      type: "tool",
      session,
      command,
      status: "completed",
      raw: {
        method: "item/completed",
        payload: JSON.stringify({
          item: { command, exitCode: 0, id, status: "completed", type: "commandExecution" }
        })
      }
    });
    persistence.push(commandCompleted("ordinary", "git status"));
    persistence.push(commandCompleted("verification", "bun test src/example.test.ts"));
    persistence.flush();

    expect(persisted).toHaveLength(2);
    expect(persisted.map((event) => event.command)).toEqual([
      "git status",
      "bun test src/example.test.ts"
    ]);
    expect(persisted[0]).toMatchObject({
      payload: {
        exit_code: 0,
        raw_payload_omitted: true,
        representation: "terminal_tool_observation",
        schema_version: TOOL_OBSERVATION_SCHEMA_VERSION
      },
      raw: { method: "item/completed" }
    });
    expect(persisted[0]?.raw?.payload).toBeUndefined();
  });

  test("normal mode stores unified exec verification results", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event), { mode: "normal" });
    persistence.push({
      provider: "codex",
      type: "tool",
      session,
      command: "node --test src/example.test.js",
      status: "completed",
      raw: {
        method: "item/completed",
        payload: JSON.stringify({
          item: {
            arguments: 'const r = await tools.exec_command({"cmd":"node --test src/example.test.js","workdir":"/repo"}); text(r.output);',
            contentItems: [{ type: "inputText", text: "Script completed\nOutput:\n1 pass" }],
            id: "dynamic-verification",
            status: "completed",
            success: true,
            tool: "exec",
            type: "dynamicToolCall"
          }
        })
      }
    });
    persistence.flush();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ command: "node --test src/example.test.js" });
  });

  test("normal mode keeps only the final cost observation", () => {
    const persisted: ProviderEvent[] = [];
    const persistence = createIssueLogPersistence((event) => persisted.push(event), { mode: "normal" });
    for (let index = 1; index <= 50; index += 1) {
      persistence.push(costEvent(index));
    }
    persistence.push({
      provider: "codex",
      type: "done",
      session,
      status: "completed",
      raw: { method: "turn/completed", payload: "completed" }
    });

    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({
      payload: {
        raw_payload_omitted: true,
        representation: "final_run_cost",
        schema_version: RUN_COST_OBSERVATION_SCHEMA_VERSION
      },
      raw: { method: "thread/tokenUsage/updated" },
      runEvent: { cost: { usage: { total_tokens: 50 } } }
    });
    expect(persisted[0]?.raw?.payload).toBeUndefined();
    expect(persisted[1]).toMatchObject({ type: "done", raw: { method: "turn/completed" } });
  });
}
