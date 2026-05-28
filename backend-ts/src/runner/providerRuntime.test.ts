import { describe, expect, test } from "bun:test";
import { runIssueWithProvider } from "./providerRuntime.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import type { ExecutorProvider, ProviderEvent, ProviderRunInput } from "../providers/types.ts";

class FakeExecutionProvider implements ExecutorProvider {
  readonly id = "fake-execution-only" as const;
  readonly capabilities = ["issue_execution"] as const;
  lastInput?: ProviderRunInput;

  async run(input: ProviderRunInput) {
    this.lastInput = input;
    input.onEvent?.({
      provider: this.id,
      type: "provider.message",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" },
      text: "fake provider log"
    });
    return {
      runId: "fake-run",
      session: { provider: this.id, sessionId: "fake-session", turnId: "fake-turn" }
    };
  }
}

describe("executor provider runtime seam", () => {
  test("PI is not modeled as an executor provider id", () => {
    expect(isExecutorProviderId("pi")).toBe(false);
  });

  test("runner layer can execute a fake provider and observe session refs/events", async () => {
    const provider = new FakeExecutionProvider();
    const events: ProviderEvent[] = [];

    const result = await runIssueWithProvider(provider, {
      issueId: 154,
      projectId: "codex-issue-runner",
      cwd: "/tmp/project",
      prompt: "issue prompt",
      model: "codex-default",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      onLog: (event) => events.push(event)
    });

    expect(provider.lastInput).toMatchObject({ issueId: 154, projectId: "codex-issue-runner" });
    expect(result).toEqual({
      runId: "fake-run",
      session: { provider: "fake-execution-only", sessionId: "fake-session", turnId: "fake-turn" }
    });
    expect(events).toEqual([{
      provider: "fake-execution-only",
      type: "provider.message",
      text: "fake provider log",
      session: result.session
    }]);
  });
});
