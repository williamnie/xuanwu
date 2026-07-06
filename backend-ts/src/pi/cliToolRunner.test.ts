import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_TOOL_ERROR_CODES, runCliTool } from "./cliToolRunner.ts";
import type { CliConnectorCommand } from "./cliConnectorManifest.ts";

const SCRIPT = `
const mode = process.argv[2];
if (mode === "echo") {
  const token = process.env.FIXTURE_TOKEN || "";
  process.stderr.write("token=" + token + "\\n");
  console.log(JSON.stringify({
    args: process.argv.slice(3),
    cwd: process.cwd(),
    other: process.env.OTHER_SECRET ? "present" : "missing",
    env_present: token ? "present" : "missing"
  }));
} else if (mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3] || 500)));
  console.log(JSON.stringify({ ok: true }));
} else if (mode === "exit") {
  process.stderr.write("usage failed\\n");
  process.exit(Number(process.argv[3] || 64));
} else if (mode === "invalid") {
  console.log("not json");
} else if (mode === "chatty-fail") {
  process.stdout.write("stdout-abcdef");
  process.stderr.write("stderr-uvwxyz");
  process.exit(64);
}
`;

describe("CLI tool runner", () => {
  test("executes a fixture command with cwd, allowlisted env, and JSON stdout", async () => {
    const { cwd, script } = await fixture();
    const result = await runCliTool({
      command: fixtureCommand(script, ["echo", "{{input.payload}}", "{{input.limit}}"]),
      cwd,
      env: { FIXTURE_TOKEN: "secret-value", OTHER_SECRET: "blocked" },
      envAllowlist: ["FIXTURE_TOKEN"],
      input: { limit: 3, payload: "hello" },
      invocationID: "call-ok",
      secretEnvNames: ["FIXTURE_TOKEN"]
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({
      args: ["hello", "3"],
      cwd,
      env_present: "present",
      other: "missing",
    });
    expect(cli(result).env_names).toEqual(["FIXTURE_TOKEN"]);
    expect((cli(result).stderr as { text?: string }).text).toContain("[redacted]");
    expect(JSON.stringify(result)).not.toContain("secret-value");
  });

  test("passes template input as one argv value instead of shell text", async () => {
    const { cwd, script } = await fixture();
    const marker = join(cwd, "pwned");
    const payload = `$(touch ${marker}); echo owned`;
    const result = await runCliTool({
      command: fixtureCommand(script, ["echo", "{{input.payload}}"]),
      cwd,
      input: { payload },
      invocationID: "call-argv"
    });

    expect(result.status).toBe("succeeded");
    expect(result.output).toMatchObject({ args: [payload] });
    expect(existsSync(marker)).toBe(false);
  });

  test("returns a stable timeout error type", async () => {
    const { script } = await fixture();
    const result = await runCliTool({
      command: fixtureCommand(script, ["sleep", "500"]),
      invocationID: "call-timeout",
      timeoutMs: 30
    });

    expect(result.status).toBe("timeout");
    expect(result.error?.code).toBe(CLI_TOOL_ERROR_CODES.timeout);
  });

  test("returns a stable non-zero exit error type and category", async () => {
    const { script } = await fixture();
    const result = await runCliTool({
      command: fixtureCommand(script, ["exit", "64"]),
      invocationID: "call-exit"
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(CLI_TOOL_ERROR_CODES.nonZeroExit);
    expect((result.error?.details as { exit_category?: string }).exit_category).toBe("usage_error");
  });

  test("returns a stable invalid JSON error type", async () => {
    const { script } = await fixture();
    const result = await runCliTool({
      command: fixtureCommand(script, ["invalid"]),
      invocationID: "call-invalid"
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe(CLI_TOOL_ERROR_CODES.invalidJson);
  });

  test("truncates captured streams and redacts secret env values", async () => {
    const { script } = await fixture();
    const result = await runCliTool({
      command: fixtureCommand(script, ["chatty-fail"]),
      env: { FIXTURE_TOKEN: "secret" },
      envAllowlist: ["FIXTURE_TOKEN"],
      invocationID: "call-chatty",
      secretEnvNames: ["FIXTURE_TOKEN"],
      stderrMaxBytes: 7,
      stdoutMaxBytes: 7
    });

    expect(result.status).toBe("failed");
    expect(cli(result).stdout).toMatchObject({ text: "stdout-", truncated: true });
    expect(cli(result).stderr).toMatchObject({ text: "-uvwxyz", truncated: true });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

async function fixture(): Promise<{ cwd: string; script: string }> {
  const cwdRaw = await mkdtemp(join(tmpdir(), "codex-runner-cli-tool-"));
  const cwd = await realpath(cwdRaw);
  const script = join(cwdRaw, "fixture.mjs");
  await writeFile(script, SCRIPT);
  return { cwd, script };
}

function fixtureCommand(script: string, args: string[]): CliConnectorCommand {
  return {
    command: { executable: process.execPath, args: [script, ...args] },
    description: "fixture command",
    exit_codes: { auth_required: [20], retryable: [75], success: [0], usage_error: [64] },
    input_schema: { properties: { limit: { type: "integer" }, payload: { type: "string" } }, type: "object" },
    name: "fixture",
    output_schema: { type: "object" },
    permission: "read",
    stderr: { max_bytes: 2048, summary: "tail" },
    stdout: { mode: "json" }
  };
}

function cli(result: Awaited<ReturnType<typeof runCliTool>>): Record<string, unknown> {
  return (result.metadata as { cli: Record<string, unknown> }).cli;
}
