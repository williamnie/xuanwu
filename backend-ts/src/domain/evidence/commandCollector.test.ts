import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunAttemptID } from "../run/contracts.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { validateEvidence } from "./contracts.ts";
import {
  FileSystemCommandEvidenceArtifactStore,
  createCommandEvidenceCollector,
  fingerprintCommandEnvironment,
  normalizeCommandPath,
  type CollectCommandEvidenceInput,
  type CommandEnvironment,
  type CommandEvidenceKind
} from "./commandCollector.ts";

const STARTED_AT = "2026-07-16T09:30:00.000Z";
const ENDED_AT = "2026-07-16T09:30:01.250Z";
const COLLECTED_AT = "2026-07-16T09:30:02.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("command Evidence collector", () => {
  test("collects shell, test, lint and build success with deterministic provenance", async () => {
    const collector = createCommandEvidenceCollector();
    const expectedSources = {
      shell: "command_execution",
      test: "test_runner",
      lint: "linter",
      build: "build_system"
    } as const;

    for (const kind of ["shell", "test", "lint", "build"] as const) {
      const evidence = await collector.collect(fixture(kind, {
        command: commandFor(kind),
        exit_code: 0,
        stdout: `${kind} completed\nall checks passed`
      }));

      expect(evidence).toMatchObject({
        kind,
        status: "passed",
        created_at: STARTED_AT,
        observed_at: ENDED_AT,
        completed_at: ENDED_AT,
        updated_at: COLLECTED_AT,
        decisive_output: {
          exit_code: 0,
          facts: {
            duration_ms: 1250,
            outcome: "passed",
            output_overflow: false,
            timed_out: false
          }
        },
        provenance: {
          assertion_origin: "tool_result",
          source_kind: expectedSources[kind]
        }
      });
      expect(evidence.decisive_output.summary).toContain("passed with exit 0");
      expect(evidence.decisive_output.excerpt).toContain("all checks passed");
      expect(validateEvidence(evidence)).toMatchObject({ known_kind: true, ok: true });
    }
  });

  test("maps non-zero exit, timeout, signal and missing exit without trusting command text", async () => {
    const collector = createCommandEvidenceCollector();
    const failed = await collector.collect(fixture("test", {
      command: "bun test",
      exit_code: 7,
      stderr: "2 tests failed"
    }));
    expect(failed).toMatchObject({
      status: "failed",
      decisive_output: { exit_code: 7, excerpt: "2 tests failed", facts: { outcome: "exit_nonzero" } }
    });

    const timeout = await collector.collect(fixture("lint", {
      command: "bunx eslint .",
      exit_code: 0,
      timed_out: true,
      stderr: "still running"
    }));
    expect(timeout).toMatchObject({
      status: "failed",
      decisive_output: { facts: { outcome: "timeout", timed_out: true } }
    });
    expect(timeout.decisive_output.summary).toContain("timed out");

    const signal = await collector.collect(fixture("build", {
      command: "bun run build",
      exit_code: null,
      signal: "SIGTERM",
      stderr: "terminated"
    }));
    expect(signal).toMatchObject({
      status: "failed",
      decisive_output: { facts: { outcome: "signal", signal: "SIGTERM" } }
    });
    expect(signal.decisive_output).not.toHaveProperty("exit_code");

    const inconclusive = await collector.collect(fixture("shell", {
      command: "tool-without-exit",
      exit_code: null
    }));
    expect(inconclusive).toMatchObject({
      status: "blocked",
      decisive_output: { facts: { outcome: "missing_exit" } }
    });
  });

  test("writes oversized redacted output to a content-addressed artifact and keeps a bounded decisive tail", async () => {
    const root = mkdtempSync(join(tmpdir(), "command-evidence-"));
    tempDirs.push(root);
    const collector = createCommandEvidenceCollector({
      artifact_store: new FileSystemCommandEvidenceArtifactStore(root),
      decisive_excerpt_max_bytes: 160,
      inline_output_max_bytes: 256
    });
    const stdout = `${"progress\n".repeat(200)}CODEX_TOKEN=super-secret\nFINAL: 48 tests passed`;
    const evidence = await collector.collect(fixture("test", {
      command: "API_KEY=command-secret bun test",
      exit_code: 0,
      stdout
    }));

    expect(evidence.decisive_output.facts.output_overflow).toBe(true);
    expect(Buffer.byteLength(evidence.decisive_output.excerpt ?? "")).toBeLessThanOrEqual(160);
    expect(evidence.decisive_output.excerpt).toContain("FINAL: 48 tests passed");
    expect(evidence.artifact_refs).toHaveLength(1);
    const artifact = evidence.artifact_refs[0]!;
    expect(artifact).toMatchObject({ kind: "log", media_type: "text/plain; charset=utf-8" });
    const stored = readFileSync(join(root, artifact.ref), "utf8");
    expect(stored).toContain("FINAL: 48 tests passed");
    expect(stored).not.toContain("super-secret");
    expect(stored).not.toContain("command-secret");
    expect(statSync(join(root, artifact.ref)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(evidence)).not.toContain("super-secret");
    expect(JSON.stringify(evidence)).not.toContain("command-secret");
    expect(evidence.redaction.status).toBe("applied");
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  test("refuses to discard overflow when no artifact store is available", async () => {
    const collector = createCommandEvidenceCollector({ inline_output_max_bytes: 64 });
    await expect(collector.collect(fixture("shell", {
      command: "printf output",
      exit_code: 0,
      stdout: "x".repeat(256)
    }))).rejects.toThrow("no artifact store was provided");
  });

  test("normalizes POSIX and Windows paths with the observed platform semantics", async () => {
    expect(normalizeCommandPath("/workspace/app/../repo", "linux")).toBe("/workspace/repo");
    expect(normalizeCommandPath("C:\\workspace\\app\\..\\repo", "win32")).toBe("C:\\workspace\\repo");

    const collector = createCommandEvidenceCollector();
    const windows = await collector.collect({
      ...fixture("build", {
        command: "\"C:\\Program Files\\Bun\\bun.exe\" run build",
        cwd: "C:\\workspace\\app\\..\\repo",
        exit_code: 0
      }),
      environment: environment({
        architecture: "x64",
        platform: "win32",
        runtime_name: "bun",
        runtime_version: "1.3.6",
        shell: "C:\\Windows\\System32\\cmd.exe"
      })
    });
    expect(windows.decisive_output.facts.command).toBe("\"C:\\Program Files\\Bun\\bun.exe\" run build");
    expect(windows.decisive_output.facts.working_directory).toBe("C:\\workspace\\repo");
  });

  test("fingerprints stable environment facts without including sensitive variable names", () => {
    const first = environment({ environment_variable_names: ["PATH", "LANG", "CODEX_TOKEN"] });
    const reordered = environment({ environment_variable_names: ["LANG", "OTHER_SECRET", "PATH"] });
    expect(fingerprintCommandEnvironment(first, "/workspace/repo"))
      .toBe(fingerprintCommandEnvironment(reordered, "/workspace/repo"));
    expect(fingerprintCommandEnvironment(first, "/workspace/repo"))
      .not.toBe(fingerprintCommandEnvironment({ ...first, runtime_version: "1.3.7" }, "/workspace/repo"));
  });
});

function fixture(
  kind: CommandEvidenceKind,
  observation: Partial<CollectCommandEvidenceInput["observation"]> = {}
): CollectCommandEvidenceInput {
  const runID = makeDomainID("run", "issue_runs", `664:${kind}`);
  return {
    kind,
    context: {
      attempt_id: makeRunAttemptID(runID, 1),
      audit_event_ref: `issue_events:664:${kind}:command`,
      collected_at: COLLECTED_AT,
      evidence_id: makeDomainID("evidence", "issue_events", `664:${kind}:command`),
      producer: { id: "runner-command-collector", kind: "runner" },
      run_id: runID,
      source_ref: `provider-command:fixture:${kind}`,
      work_id: makeDomainID("work", "issues", 664)
    },
    environment: environment(),
    observation: {
      command: "true",
      cwd: "/workspace/repo",
      duration_ms: 1250,
      ended_at: ENDED_AT,
      exit_code: 0,
      started_at: STARTED_AT,
      stderr: "",
      stdout: "",
      timed_out: false,
      ...observation
    }
  };
}

function environment(overrides: Partial<CommandEnvironment> = {}): CommandEnvironment {
  return {
    architecture: "arm64",
    environment_variable_names: ["PATH", "LANG"],
    platform: "darwin",
    runtime_name: "bun",
    runtime_version: "1.3.6",
    shell: "/bin/zsh",
    ...overrides
  };
}

function commandFor(kind: CommandEvidenceKind): string {
  switch (kind) {
    case "test": return "bun test";
    case "lint": return "bunx eslint .";
    case "build": return "bun run build";
    default: return "git diff --check";
  }
}
