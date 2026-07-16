import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve, sep, win32 } from "node:path";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  redactEvidenceText,
  validateEvidence,
  type EvidenceArtifactRef,
  type EvidenceID,
  type EvidenceRecord,
  type RunAttemptID,
  type RunID,
  type WorkID
} from "./contracts.ts";

export const COMMAND_EVIDENCE_KINDS = ["shell", "test", "lint", "build"] as const;
export type CommandEvidenceKind = typeof COMMAND_EVIDENCE_KINDS[number];

export type CommandExecutionObservation = {
  command: string;
  cwd: string;
  duration_ms: number;
  ended_at: string;
  exit_code: number | null;
  signal?: string | null;
  started_at: string;
  stderr?: string;
  stdout?: string;
  timed_out?: boolean;
};

export type CommandEnvironment = {
  architecture: string;
  environment_variable_names?: readonly string[];
  platform: string;
  runtime_name: string;
  runtime_version: string;
  shell?: string;
};

export type CommandEvidenceContext = {
  attempt_id?: RunAttemptID;
  audit_event_ref: string;
  collected_at?: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

export type CollectCommandEvidenceInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  context: CommandEvidenceContext;
  environment?: CommandEnvironment;
  kind: CommandEvidenceKind;
  observation: CommandExecutionObservation;
  success_exit_codes?: readonly number[];
};

export type CommandOutputArtifactWrite = {
  audit_event_ref: string;
  bytes: number;
  content: string;
  evidence_id: EvidenceID;
  kind: CommandEvidenceKind;
  sha256: string;
  source_ref: string;
};

export interface CommandEvidenceArtifactStore {
  writeCommandOutput(input: CommandOutputArtifactWrite): Promise<EvidenceArtifactRef> | EvidenceArtifactRef;
}

export interface CommandEvidenceCollector {
  collect(input: CollectCommandEvidenceInput): Promise<EvidenceRecord>;
}

export type CommandEvidenceCollectorOptions = {
  artifact_store?: CommandEvidenceArtifactStore;
  decisive_excerpt_max_bytes?: number;
  inline_output_max_bytes?: number;
};

const DEFAULT_DECISIVE_EXCERPT_MAX_BYTES = 4 * 1024;
const DEFAULT_INLINE_OUTPUT_MAX_BYTES = 8 * 1024;
const MAX_FACT_TEXT_BYTES = 8 * 1024;
const COMMAND_ARTIFACT_ROOT = "artifacts/evidence-command-output";
const SENSITIVE_ENV_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|AUTH)(?:_|$)/i;

export function createCommandEvidenceCollector(
  options: CommandEvidenceCollectorOptions = {}
): CommandEvidenceCollector {
  const excerptLimit = boundedPositiveInteger(
    options.decisive_excerpt_max_bytes,
    DEFAULT_DECISIVE_EXCERPT_MAX_BYTES,
    MAX_FACT_TEXT_BYTES
  );
  const inlineLimit = boundedPositiveInteger(
    options.inline_output_max_bytes,
    DEFAULT_INLINE_OUTPUT_MAX_BYTES,
    16 * 1024 * 1024
  );

  return {
    async collect(input) {
      validateInput(input);
      const environment = input.environment ?? currentCommandEnvironment();
      const observation = normalizedObservation(input.observation, environment.platform);
      const successExitCodes = normalizedSuccessExitCodes(input.success_exit_codes);
      const outcome = commandOutcome(observation, successExitCodes);
      const transcript = commandTranscript(observation);
      const requiresArtifact = Buffer.byteLength(transcript) > inlineLimit ||
        Buffer.byteLength(observation.command) > MAX_FACT_TEXT_BYTES ||
        Buffer.byteLength(observation.cwd) > MAX_FACT_TEXT_BYTES;
      const artifactRefs = uniqueArtifactRefs(input.artifact_refs ?? []);
      if (requiresArtifact) {
        if (!options.artifact_store) {
          throw new Error("command output exceeds the inline Evidence limit but no artifact store was provided");
        }
        const safeTranscript = redactEvidenceText(transcript);
        const bytes = Buffer.from(safeTranscript);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifact = await options.artifact_store.writeCommandOutput({
          audit_event_ref: input.context.audit_event_ref,
          bytes: bytes.byteLength,
          content: safeTranscript,
          evidence_id: input.context.evidence_id,
          kind: input.kind,
          sha256,
          source_ref: input.context.source_ref
        });
        if (artifact.sha256 !== sha256) throw new Error("command output artifact checksum does not match the collected output");
        artifactRefs.push(artifact);
      }

      const completedAt = observation.ended_at;
      const excerpt = decisiveOutput(observation, outcome, excerptLimit, requiresArtifact);
      const evidence: EvidenceRecord = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        id: input.context.evidence_id,
        work_id: input.context.work_id,
        ...(input.context.run_id ? { run_id: input.context.run_id } : {}),
        ...(input.context.attempt_id ? { attempt_id: input.context.attempt_id } : {}),
        revision: 0,
        kind: input.kind,
        status: outcome.status,
        created_at: observation.started_at,
        observed_at: observation.ended_at,
        updated_at: collectedAt(input.context.collected_at, completedAt),
        completed_at: completedAt,
        decisive_output: {
          summary: outcomeSummary(input.kind, outcome.reason, observation),
          ...(excerpt ? { excerpt } : {}),
          ...(observation.exit_code === null ? {} : { exit_code: observation.exit_code }),
          facts: {
            command: boundedHead(observation.command, MAX_FACT_TEXT_BYTES),
            duration_ms: observation.duration_ms,
            environment_architecture: boundedHead(environment.architecture.trim(), MAX_FACT_TEXT_BYTES),
            environment_fingerprint: fingerprintCommandEnvironment(environment, observation.cwd),
            environment_platform: boundedHead(environment.platform.trim(), MAX_FACT_TEXT_BYTES),
            environment_runtime: boundedHead(`${environment.runtime_name.trim()}@${environment.runtime_version.trim()}`, MAX_FACT_TEXT_BYTES),
            environment_variable_count: normalizedEnvironmentVariableNames(environment.environment_variable_names).length,
            outcome: outcome.reason,
            output_overflow: requiresArtifact,
            stderr_bytes: Buffer.byteLength(observation.stderr),
            stdout_bytes: Buffer.byteLength(observation.stdout),
            timed_out: observation.timed_out,
            working_directory: boundedHead(observation.cwd, MAX_FACT_TEXT_BYTES),
            ...(observation.signal ? { signal: boundedHead(observation.signal, MAX_FACT_TEXT_BYTES) } : {})
          }
        },
        artifact_refs: uniqueArtifactRefs(artifactRefs),
        provenance: {
          assertion_origin: "tool_result",
          source_kind: sourceKind(input.kind),
          source_ref: input.context.source_ref,
          audit_event_ref: input.context.audit_event_ref,
          producer: input.context.producer
        },
        redaction: {
          status: "not_required",
          policy_ref: "evidence-redaction:v1",
          redacted_paths: []
        }
      };
      const redacted = redactEvidenceRecord(evidence, "evidence-redaction:v1");
      const validation = validateEvidence(redacted);
      if (!validation.ok) throw new Error(`command collector produced invalid Evidence: ${validation.errors.join("; ")}`);
      return redacted;
    }
  };
}

export class FileSystemCommandEvidenceArtifactStore implements CommandEvidenceArtifactStore {
  constructor(private readonly stateDir: string) {
    if (stateDir.trim() === "") throw new Error("command Evidence artifact state directory is required");
  }

  writeCommandOutput(input: CommandOutputArtifactWrite): EvidenceArtifactRef {
    const bytes = Buffer.from(input.content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.bytes || sha256 !== input.sha256) {
      throw new Error("command output artifact content does not match its declared digest");
    }
    const ref = `${COMMAND_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.log`;
    const path = this.artifactPath(ref);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return {
      kind: "log",
      ref,
      label: `${input.kind} command full output`,
      media_type: "text/plain; charset=utf-8",
      sha256
    };
  }

  private artifactPath(ref: string): string {
    if (!new RegExp(`^${COMMAND_ARTIFACT_ROOT}/[a-f0-9]{2}/[a-f0-9]{64}\\.log$`).test(ref)) {
      throw new Error("invalid command Evidence artifact ref");
    }
    const root = resolve(this.stateDir, COMMAND_ARTIFACT_ROOT);
    const path = resolve(this.stateDir, ref);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("command Evidence artifact ref escapes state directory");
    }
    return path;
  }
}

export function currentCommandEnvironment(): CommandEnvironment {
  return {
    architecture: process.arch,
    environment_variable_names: Object.keys(process.env),
    platform: process.platform,
    runtime_name: typeof Bun === "undefined" ? "node" : "bun",
    runtime_version: typeof Bun === "undefined" ? process.version : Bun.version,
    shell: process.env.SHELL ?? process.env.ComSpec ?? ""
  };
}

export function fingerprintCommandEnvironment(environment: CommandEnvironment, cwd: string): string {
  const canonical = {
    architecture: environment.architecture.trim().toLowerCase(),
    cwd: normalizeCommandPath(cwd, environment.platform),
    environment_variable_names: normalizedEnvironmentVariableNames(environment.environment_variable_names),
    platform: environment.platform.trim().toLowerCase(),
    runtime_name: environment.runtime_name.trim().toLowerCase(),
    runtime_version: environment.runtime_version.trim(),
    shell: normalizeOptionalCommandPath(environment.shell ?? "", environment.platform)
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function normalizeCommandPath(value: string, platform: string): string {
  const text = value.trim();
  if (text === "") throw new Error("command working directory is required");
  return platform.trim().toLowerCase() === "win32" ? win32.normalize(text) : posix.normalize(text);
}

function normalizedObservation(
  observation: CommandExecutionObservation,
  platform: string
): Required<Omit<CommandExecutionObservation, "signal">> & { signal: string | null } {
  return {
    command: observation.command.trim(),
    cwd: normalizeCommandPath(observation.cwd, platform),
    duration_ms: observation.duration_ms,
    ended_at: normalizedTimestamp(observation.ended_at, "command ended_at"),
    exit_code: observation.exit_code,
    signal: cleanOptionalString(observation.signal),
    started_at: normalizedTimestamp(observation.started_at, "command started_at"),
    stderr: observation.stderr ?? "",
    stdout: observation.stdout ?? "",
    timed_out: observation.timed_out === true
  };
}

function validateInput(input: CollectCommandEvidenceInput): void {
  if (!COMMAND_EVIDENCE_KINDS.includes(input.kind)) throw new Error("unsupported command Evidence kind");
  if (input.observation.command.trim() === "") throw new Error("command is required");
  if (!Number.isSafeInteger(input.observation.duration_ms) || input.observation.duration_ms < 0) {
    throw new Error("command duration_ms must be a non-negative integer");
  }
  if (input.observation.exit_code !== null && !Number.isSafeInteger(input.observation.exit_code)) {
    throw new Error("command exit_code must be an integer or null");
  }
  const started = Date.parse(input.observation.started_at);
  const ended = Date.parse(input.observation.ended_at);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    throw new Error("command timestamps must be ordered ISO timestamps");
  }
  const environment = input.environment;
  if (environment && [environment.architecture, environment.platform, environment.runtime_name, environment.runtime_version]
    .some((value) => value.trim() === "")) {
    throw new Error("command environment platform, architecture, runtime name and version are required");
  }
}

type CommandOutcome = {
  reason: "passed" | "exit_nonzero" | "signal" | "timeout" | "missing_exit";
  status: EvidenceRecord["status"];
};

function commandOutcome(
  observation: ReturnType<typeof normalizedObservation>,
  successExitCodes: ReadonlySet<number>
): CommandOutcome {
  if (observation.timed_out) return { reason: "timeout", status: "failed" };
  if (observation.signal) return { reason: "signal", status: "failed" };
  if (observation.exit_code === null) return { reason: "missing_exit", status: "blocked" };
  if (successExitCodes.has(observation.exit_code)) return { reason: "passed", status: "passed" };
  return { reason: "exit_nonzero", status: "failed" };
}

function outcomeSummary(
  kind: CommandEvidenceKind,
  reason: CommandOutcome["reason"],
  observation: ReturnType<typeof normalizedObservation>
): string {
  const label = kind[0]!.toUpperCase() + kind.slice(1);
  if (reason === "timeout") return `${label} command timed out after ${observation.duration_ms} ms`;
  if (reason === "signal") return `${label} command terminated by ${observation.signal} after ${observation.duration_ms} ms`;
  if (reason === "missing_exit") return `${label} command produced no terminal exit result after ${observation.duration_ms} ms`;
  if (reason === "passed") return `${label} command passed with exit ${observation.exit_code} in ${observation.duration_ms} ms`;
  return `${label} command failed with exit ${observation.exit_code} in ${observation.duration_ms} ms`;
}

function decisiveOutput(
  observation: ReturnType<typeof normalizedObservation>,
  outcome: CommandOutcome,
  limit: number,
  hasArtifact: boolean
): string {
  const selected = outcome.reason === "passed"
    ? observation.stdout.trim() || observation.stderr.trim()
    : observation.stderr.trim() || observation.stdout.trim();
  if (selected === "") return "";
  return boundedTail(selected, limit, hasArtifact);
}

function commandTranscript(observation: ReturnType<typeof normalizedObservation>): string {
  return [
    `$ ${observation.command}`,
    `cwd: ${observation.cwd}`,
    `exit_code: ${observation.exit_code ?? "null"}`,
    `signal: ${observation.signal ?? "null"}`,
    `timed_out: ${observation.timed_out}`,
    `duration_ms: ${observation.duration_ms}`,
    "--- stdout ---",
    observation.stdout,
    "--- stderr ---",
    observation.stderr
  ].join("\n");
}

function sourceKind(kind: CommandEvidenceKind): EvidenceRecord["provenance"]["source_kind"] {
  switch (kind) {
    case "test": return "test_runner";
    case "lint": return "linter";
    case "build": return "build_system";
    default: return "command_execution";
  }
}

function normalizedSuccessExitCodes(values: readonly number[] | undefined): ReadonlySet<number> {
  const codes = values ?? [0];
  if (codes.length === 0 || codes.some((code) => !Number.isSafeInteger(code))) {
    throw new Error("success_exit_codes must contain at least one integer");
  }
  return new Set(codes);
}

function normalizedEnvironmentVariableNames(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? [])
    .map((value) => value.trim())
    .filter((value) => value !== "" && !SENSITIVE_ENV_NAME.test(value)))]
    .sort();
}

function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const refs = new Set<string>();
  return values.filter((artifact) => {
    if (refs.has(artifact.ref)) return false;
    refs.add(artifact.ref);
    return true;
  }).map((artifact) => ({ ...artifact }));
}

function collectedAt(value: string | undefined, completedAt: string): string {
  if (!value) return completedAt;
  const normalized = normalizedTimestamp(value, "Evidence collected_at");
  return normalized < completedAt ? completedAt : normalized;
}

function normalizedTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO timestamp`);
  const normalized = new Date(time).toISOString();
  if (normalized !== value) throw new Error(`${label} must use canonical ISO format`);
  return normalized;
}

function normalizeOptionalCommandPath(value: string, platform: string): string {
  const text = value.trim();
  return text === "" ? "" : normalizeCommandPath(text, platform);
}

function cleanOptionalString(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`collector byte limit must be between 1 and ${maximum}`);
  }
  return value;
}

function boundedHead(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const marker = "\n…[truncated; full value in artifact]";
  return `${utf8Head(value, byteLimit - Buffer.byteLength(marker))}${marker}`;
}

function boundedTail(value: string, byteLimit: number, hasArtifact: boolean): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const marker = hasArtifact
    ? "…[earlier output omitted; full output in artifact]\n"
    : "…[earlier output omitted]\n";
  return `${marker}${utf8Tail(value, byteLimit - Buffer.byteLength(marker))}`;
}

function utf8Head(value: string, byteLimit: number): string {
  if (byteLimit <= 0) return "";
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.byteLength, byteLimit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function utf8Tail(value: string, byteLimit: number): string {
  if (byteLimit <= 0) return "";
  const bytes = Buffer.from(value);
  let start = Math.max(0, bytes.byteLength - byteLimit);
  while (start < bytes.byteLength && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}
