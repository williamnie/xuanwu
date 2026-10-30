import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderRuntimeConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { cancelIssueWithInterrupt } from "../../runner/interrupt.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { ClaudeExecutorProvider, ClaudeSdkExecutorProvider, type ClaudeProcessFactory } from "./provider.ts";
import { inspectClaudeCliAuth } from "./cliProvider.ts";
import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";

export const tempRoots: string[] = [];

export function runtimeConfig(overrides: Partial<ProviderRuntimeConfig> = {}): ProviderRuntimeConfig {
  return {
    command: "claude",
    cwd: "",
    env: {},
    timeoutMs: 30_000,
    ...overrides
  };
}

export function runInput() {
  return { issueId: 183, projectId: "demo", cwd: "/tmp", prompt: "issue prompt" };
}

export function claudePolicy(request: {
  access: "provider-native-development" | "unrestricted-host";
  approval: "ask-every-side-effect" | "unattended";
}) {
  return resolveExecutionPolicy({ contract: "xw.execution-policy.v1", ...request }, {
    cwd: "/tmp",
    invocationRef: "claude-test",
    projectId: "demo",
    providerId: "claude",
    providerVersion: "0.3.152",
    source: "local-user",
    transport: "sdk"
  }, CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter);
}

export async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected promise to reject");
}

export function scriptedProcessFactory(input: { exitCode?: number; stderr?: string; stdout?: string }) {
  const calls: Array<{ command: string[]; cwd?: string; env: Record<string, string | undefined> }> = [];
  const factory: ClaudeProcessFactory = (call) => {
    calls.push(call);
    return {
      stdout: streamFrom(input.stdout ?? ""),
      stderr: streamFrom(input.stderr ?? ""),
      exited: Promise.resolve(input.exitCode ?? 0),
      kill: () => undefined
    };
  };
  return { calls, factory };
}

export function hangingProcessFactory() {
  let killed = false;
  let closeStdout: (() => void) | undefined;
  let closeStderr: (() => void) | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const factory: ClaudeProcessFactory = () => ({
    stdout: closableStream((close) => { closeStdout = close; }),
    stderr: closableStream((close) => { closeStderr = close; }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: () => {
      killed = true;
      closeStdout?.();
      closeStderr?.();
      resolveExit?.(143);
    }
  });
  return { factory, get killed() { return killed; } };
}

export function stubbornProcessFactory() {
  const signals: Array<string | number | undefined> = [];
  let closeStdout: (() => void) | undefined;
  let closeStderr: (() => void) | undefined;
  let resolveExit: ((code: number) => void) | undefined;
  const factory: ClaudeProcessFactory = () => ({
    stdout: closableStream((close) => { closeStdout = close; }),
    stderr: closableStream((close) => { closeStderr = close; }),
    exited: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: (signal) => {
      signals.push(signal);
      if (signal !== "SIGKILL") return;
      closeStdout?.();
      closeStderr?.();
      resolveExit?.(137);
    }
  });
  return { factory, signals };
}

export function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text !== "") controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}

export function closableStream(register: (close: () => void) => void): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { register(() => controller.close()); } });
}

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition timed out");
}

export function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-claude-provider-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

export function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, "claude", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

export function insertIssue(db: RunnerDatabase, projectId: string, status = "in_progress"): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, issue_log_mode, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, "Claude runtime", status, "debug", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}
