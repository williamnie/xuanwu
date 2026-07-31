import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { listStoredEvidence } from "../../db/repositories/evidence.ts";
import { listStoredHandoffs } from "../../db/repositories/handoffs.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type IssueRun } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { codexDynamicExecObservation } from "../../providers/codex/dynamicExec.ts";
import { recoverCodexRolloutExecEvents } from "../../providers/codex/rolloutExecRecovery.ts";
import type { ProviderEvent } from "../../providers/types.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import { projectIssueAsWork } from "../work/issueAdapter.ts";

export const COMPLETION_CARD_CONTRACT = "xw.issue-completion-card.v1" as const;
export const COMPLETION_CARD_EVENT_TYPE = "issue.completion_card.v1";
export const COMPLETION_GIT_OBSERVATION_CONTRACT = "xw.issue-completion-git-observation.v1" as const;
export const COMPLETION_GIT_OBSERVATION_EVENT_TYPE = "issue.completion_git_observation.v1";
export const TERMINAL_COMMAND_OBSERVATION_CONTRACT = "xw.all-terminal-command-observations.v1" as const;

export type CompletionCardCommand = {
  command: string;
  cwd: string;
  duration_ms: number;
  exit_code: number;
  id: string;
  observed_at: string;
  output_excerpt: string;
  sequence: number;
  source: "issue_log" | "rollout_recovery";
  status: "completed" | "failed";
};

export type CompletionCard = {
  acceptance: {
    criteria: Array<{ description: string; id: string; required: boolean }>;
    handoff_policy: string;
  };
  commands: {
    items: CompletionCardCommand[];
    omitted: number;
    total: number;
  };
  contract: typeof COMPLETION_CARD_CONTRACT;
  evidence: Array<{ id: string; kind: string; status: string; summary: string }>;
  final_message: string;
  fingerprint: string;
  generated_at: string;
  git: {
    baseline_revision: string;
    changed_files: string[];
    commit_count: number;
    commits: Array<{ revision: string; subject: string; timestamp: string }>;
    final_revision: string;
    has_diff: boolean;
    observed_at: string;
    source: "legacy_reconstruction" | "terminal_observation";
    working_tree_dirty: boolean;
  };
  handoff: null | {
    changed_files: string[];
    final_revision: string;
    id: string;
    status: string;
    summary: string;
  };
  issue: {
    id: number;
    project_id: string;
    status: string;
    title: string;
    updated_at: string;
    goal: string;
  };
  provider_outcome: { outcome: string; reason: string };
  run: {
    attempt: number;
    ended_at: string;
    id: string;
    provider: string;
    provider_session_id: string;
    provider_turn_id: string;
    started_at: string;
    status: string;
  };
  warnings: string[];
};

type CommandObservation = Omit<CompletionCardCommand, "sequence">;

const MAX_COMMANDS = 36;
const MAX_COMMAND_BYTES = 2_000;
const MAX_OUTPUT_BYTES = 1_200;
const MAX_FINAL_MESSAGE_BYTES = 8_000;
const MAX_CHANGED_FILES = 200;
const MAX_COMMITS = 20;

export async function buildIssueCompletionCard(
  db: RunnerDatabase,
  issueID: number,
  options: { now?: Date } = {}
): Promise<CompletionCard> {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue #${issueID} not found`);
  const project = getProject(db, issue.project_id);
  if (!project) throw new Error(`Project ${issue.project_id} not found`);
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run || run.ended_at === "") throw new Error("completion card requires an ended canonical Run");
  const work = projectIssueAsWork(db, issue);
  const runID = makeDomainID("run", "issue_runs", run.id);
  const events = listIssueEvents(db, issueID, {
    limit: 500,
    types: [
      "issue.log",
      "issue.runner_outcome",
      "issue.pi_acceptance_requested.v1",
      COMPLETION_GIT_OBSERVATION_EVENT_TYPE
    ]
  });
  const logCommands = commandsFromIssueLogs(events, run);
  const rolloutCommands = hasCompleteTerminalObservationContract(events, run)
    ? []
    : await recoveredRolloutCommands(run);
  const allCommands = uniqueCommands([...logCommands, ...rolloutCommands]);
  const boundedCommands = boundedSequence(allCommands, MAX_COMMANDS);
  const git = gitRunSummary(project.cwd, run, events);
  const handoff = listStoredHandoffs(db, { limit: 100, work_id: work.id }).items
    .find((item) => item.handoff.run_ids.includes(runID));
  const evidence = listStoredEvidence(db, {
    issue_ids: [issueID],
    limit: 200,
    run_ids: [runID]
  }).items.map((item) => ({
    id: item.evidence.id,
    kind: item.evidence.kind,
    status: item.evidence.status,
    summary: boundedUtf8(item.evidence.decisive_output.summary, 1_000)
  }));
  const warnings = completionWarnings(run, allCommands, git.changed_files);
  const body = {
    acceptance: {
      criteria: work.acceptance.criteria.map((criterion) => ({
        description: criterion.description,
        id: criterion.id,
        required: criterion.required
      })),
      handoff_policy: work.acceptance.handoff_policy ?? "summary"
    },
    commands: {
      items: boundedCommands.map((item, sequence) => ({ ...item, sequence: sequence + 1 })),
      omitted: Math.max(0, allCommands.length - boundedCommands.length),
      total: allCommands.length
    },
    contract: COMPLETION_CARD_CONTRACT,
    evidence,
    final_message: latestFinalMessage(events, run),
    git,
    handoff: handoff ? {
      changed_files: handoff.handoff.changed_files.slice(0, MAX_CHANGED_FILES),
      final_revision: handoff.handoff.final_revision,
      id: handoff.handoff.id,
      status: handoff.handoff.status,
      summary: boundedUtf8(handoff.handoff.summary, 2_000)
    } : null,
    issue: {
      goal: issue.description.trim() || issue.title,
      id: issue.id,
      project_id: issue.project_id,
      status: issue.status,
      title: issue.title,
      updated_at: issue.updated_at
    },
    provider_outcome: providerOutcome(events, run),
    run: {
      attempt: run.attempt,
      ended_at: run.ended_at,
      id: run.id,
      provider: run.provider,
      provider_session_id: run.provider_session_id,
      provider_turn_id: run.provider_turn_id,
      started_at: run.started_at,
      status: run.status
    },
    warnings
  };
  const fingerprint = createHash("sha256").update(stableJson(body)).digest("hex");
  return { ...body, fingerprint, generated_at: (options.now ?? new Date()).toISOString() };
}

export function recordIssueCompletionCard(db: RunnerDatabase, card: CompletionCard, source: string): void {
  const existing = listIssueEvents(db, card.issue.id, {
    limit: 20,
    types: [COMPLETION_CARD_EVENT_TYPE]
  }).some((event) => objectValue(parseJson(event.payload)).fingerprint === card.fingerprint);
  if (existing) return;
  recordIssueEvent(db, card.issue.id, COMPLETION_CARD_EVENT_TYPE, {
    card,
    fingerprint: card.fingerprint,
    source
  });
}

export function readCurrentIssueCompletionCard(db: RunnerDatabase, issueID: number): CompletionCard | null {
  const issue = getIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  if (!issue || !run || run.ended_at === "") return null;
  const events = listIssueEvents(db, issueID, { limit: 20, types: [COMPLETION_CARD_EVENT_TYPE] });
  for (const event of [...events].reverse()) {
    const card = objectValue(parseJson(objectValue(parseJson(event.payload)).card));
    try {
      assertCompletionCardIntegrity(card);
      if (card.issue.id !== issue.id || card.issue.updated_at !== issue.updated_at || card.run.id !== run.id) continue;
      return card;
    } catch {
      continue;
    }
  }
  return null;
}

export function assertCompletionCardIntegrity(value: unknown): asserts value is CompletionCard {
  const card = objectValue(value);
  const issue = objectValue(card.issue);
  const run = objectValue(card.run);
  const commands = objectValue(card.commands);
  if (card.contract !== COMPLETION_CARD_CONTRACT) throw new Error("unsupported completion card contract");
  if (!Number.isSafeInteger(issue.id) || Number(issue.id) <= 0) throw new Error("completion card issue.id is invalid");
  if (cleanString(issue.project_id) === "") throw new Error("completion card issue.project_id is required");
  if (cleanString(run.id) === "" || !Number.isFinite(Date.parse(cleanString(run.ended_at)))) {
    throw new Error("completion card requires an ended Run");
  }
  if (!Array.isArray(commands.items) || !Number.isSafeInteger(commands.total) || !Number.isSafeInteger(commands.omitted)) {
    throw new Error("completion card commands summary is invalid");
  }
  const fingerprint = cleanString(card.fingerprint);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("completion card fingerprint is invalid");
  if (!Number.isFinite(Date.parse(cleanString(card.generated_at)))) throw new Error("completion card generated_at is invalid");
  if (completionCardFingerprint(card) !== fingerprint) throw new Error("completion card fingerprint does not match its facts");
}

export function completionCardFingerprint(value: Record<string, unknown> | CompletionCard): string {
  const { fingerprint: _fingerprint, generated_at: _generatedAt, ...body } = value;
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

export function recordCompletionGitObservation(
  db: RunnerDatabase,
  input: { issue_id: number; observed_at: string; repository: string; run: IssueRun }
): void {
  const baseline = gitObjectID(input.run.git_base_revision) ? input.run.git_base_revision.toLowerCase() : "";
  const head = gitText(input.repository, ["rev-parse", "--verify", "HEAD"]);
  const diffBase = gitObjectID(baseline) ? baseline : gitObjectID(head) ? head : "";
  const tracked = diffBase === "" ? [] : gitNullList(input.repository, ["diff", "--name-only", "-z", diffBase, "--"]);
  const untracked = gitNullList(input.repository, ["ls-files", "--others", "--exclude-standard", "-z", "--"]);
  const changedFiles = [...new Set([...tracked, ...untracked])].sort().slice(0, MAX_CHANGED_FILES);
  const workingTreeDirty = gitText(input.repository, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "";
  const commits = gitCommitSummary(input.repository, baseline, head);
  recordIssueEvent(db, input.issue_id, COMPLETION_GIT_OBSERVATION_EVENT_TYPE, {
    observation: {
      baseline_revision: baseline,
      changed_files: changedFiles,
      commit_count: commits.length,
      commits,
      contract: COMPLETION_GIT_OBSERVATION_CONTRACT,
      final_revision: gitObjectID(head) ? head : "",
      has_diff: changedFiles.length > 0 || (gitObjectID(baseline) && gitObjectID(head) && baseline !== head),
      observed_at: input.observed_at,
      run_id: input.run.id,
      working_tree_dirty: workingTreeDirty
    }
  });
}

function commandsFromIssueLogs(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): CommandObservation[] {
  const output: CommandObservation[] = [];
  for (const event of events) {
    if (event.type !== "issue.log") continue;
    const payload = objectValue(parseJson(event.payload));
    if (!eventBelongsToRun(payload, event.created_at, run)) continue;
    const item = objectValue(objectValue(parseJson(payload.raw_payload)).item);
    const observation = commandObservation(item, event.created_at, "issue_log");
    if (observation) output.push(observation);
  }
  return output;
}

async function recoveredRolloutCommands(run: IssueRun): Promise<CommandObservation[]> {
  if (run.provider !== "codex" || run.provider_session_id === "") return [];
  try {
    const events = await recoverCodexRolloutExecEvents({
      ephemeral: false,
      id: run.provider_session_id,
      provider: "codex",
      provider_session_id: run.provider_session_id,
      sessionId: run.provider_session_id
    }, run.provider_turn_id);
    return events.flatMap((event) => {
      const item = objectValue(objectValue(parseJson(event.raw?.payload)).item);
      const observation = commandObservation(item, run.ended_at, "rollout_recovery");
      return observation ? [observation] : [];
    });
  } catch {
    return [];
  }
}

function commandObservation(
  item: Record<string, unknown>,
  observedAt: string,
  source: CommandObservation["source"]
): CommandObservation | null {
  const dynamic = codexDynamicExecObservation(item);
  const type = cleanString(item.type);
  if (type !== "commandExecution" && !dynamic) return null;
  const command = dynamic?.command || commandText(item);
  const exitCode = dynamic?.exitCode ?? integer(item.exitCode);
  if (command === "" || exitCode === null) return null;
  const output = dynamic?.aggregatedOutput || cleanString(item.aggregatedOutput) || [
    cleanString(item.stdout), cleanString(item.stderr)
  ].filter(Boolean).join("\n");
  return {
    command: boundedUtf8(command, MAX_COMMAND_BYTES),
    cwd: boundedUtf8(dynamic?.cwd || cleanString(item.cwd) || ".", 1_000),
    duration_ms: dynamic?.durationMs ?? nonNegativeInteger(item.durationMs),
    exit_code: exitCode,
    id: boundedUtf8(dynamic?.id || cleanString(item.id) || commandIdentity(command, exitCode, observedAt), 512),
    observed_at: observedAt,
    output_excerpt: boundedExcerpt(output, MAX_OUTPUT_BYTES),
    source,
    status: exitCode === 0 ? "completed" : "failed"
  };
}

function commandText(item: Record<string, unknown>): string {
  const direct = cleanString(item.command);
  if (direct !== "") return direct;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  return actions.map((action) => cleanString(objectValue(action).command)).filter(Boolean).join(" && ");
}

function latestFinalMessage(events: ReturnType<typeof listIssueEvents>, run: IssueRun): string {
  const messages = events.flatMap((event) => {
    if (event.type !== "issue.log") return [];
    const payload = objectValue(parseJson(event.payload));
    if (!eventBelongsToRun(payload, event.created_at, run)) return [];
    const text = cleanString(payload.text);
    return text === "" ? [] : [text];
  });
  return boundedUtf8(messages.at(-1) ?? "", MAX_FINAL_MESSAGE_BYTES);
}

function providerOutcome(events: ReturnType<typeof listIssueEvents>, run: IssueRun): { outcome: string; reason: string } {
  for (const event of [...events].reverse()) {
    if (event.type !== "issue.runner_outcome") continue;
    const payload = objectValue(parseJson(event.payload));
    if (cleanString(payload.issue_run_id) !== run.id) continue;
    return { outcome: cleanString(payload.outcome), reason: cleanString(payload.reason) };
  }
  return { outcome: "unknown", reason: "" };
}

function hasCompleteTerminalObservationContract(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): boolean {
  return events.some((event) => {
    if (event.type !== "issue.pi_acceptance_requested.v1") return false;
    const payload = objectValue(parseJson(event.payload));
    return cleanString(payload.issue_run_id) === run.id
      && cleanString(payload.command_observation_contract) === TERMINAL_COMMAND_OBSERVATION_CONTRACT;
  });
}

function eventBelongsToRun(payload: Record<string, unknown>, createdAt: string, run: IssueRun): boolean {
  const correlation = objectValue(payload.runtime_evidence_correlation);
  const correlatedRun = cleanString(correlation.issue_run_id);
  if (correlatedRun !== "") return correlatedRun === run.id;
  const at = Date.parse(createdAt);
  const start = Date.parse(run.started_at);
  const end = Date.parse(run.ended_at);
  return Number.isFinite(at) && Number.isFinite(start) && Number.isFinite(end) && at >= start && at <= end;
}

function gitRunSummary(
  repository: string,
  run: IssueRun,
  events: ReturnType<typeof listIssueEvents>
): CompletionCard["git"] {
  const observed = terminalGitObservation(events, run);
  if (observed) return observed;
  const baseline = gitObjectID(run.git_base_revision) ? run.git_base_revision.toLowerCase() : "";
  const final = run.ended_at === "" ? "" : gitText(repository, ["rev-list", "-1", `--before=${run.ended_at}`, "HEAD"]);
  if (!gitObjectID(baseline) || !gitObjectID(final)) {
    return {
      baseline_revision: baseline,
      changed_files: [],
      commit_count: 0,
      commits: [],
      final_revision: gitObjectID(final) ? final : "",
      has_diff: false,
      observed_at: run.ended_at,
      source: "legacy_reconstruction",
      working_tree_dirty: false
    };
  }
  const changedFiles = gitNullList(repository, [
    "diff", "--name-only", "--no-ext-diff", "--no-renames", "-z", baseline, final, "--"
  ]).slice(0, MAX_CHANGED_FILES);
  const grouped = gitCommitSummary(repository, baseline, final);
  return {
    baseline_revision: baseline,
    changed_files: changedFiles,
    commit_count: grouped.length,
    commits: grouped,
    final_revision: final,
    has_diff: baseline !== final || changedFiles.length > 0,
    observed_at: run.ended_at,
    source: "legacy_reconstruction",
    working_tree_dirty: false
  };
}

function terminalGitObservation(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): CompletionCard["git"] | null {
  for (const event of [...events].reverse()) {
    if (event.type !== COMPLETION_GIT_OBSERVATION_EVENT_TYPE) continue;
    const observation = objectValue(objectValue(parseJson(event.payload)).observation);
    if (observation.contract !== COMPLETION_GIT_OBSERVATION_CONTRACT || cleanString(observation.run_id) !== run.id) continue;
    const commits = Array.isArray(observation.commits) ? observation.commits.flatMap((value) => {
      const item = objectValue(value);
      const revision = cleanString(item.revision);
      const subject = cleanString(item.subject);
      const timestamp = cleanString(item.timestamp);
      return gitObjectID(revision) && subject !== "" && Number.isFinite(Date.parse(timestamp))
        ? [{ revision, subject, timestamp }]
        : [];
    }).slice(0, MAX_COMMITS) : [];
    return {
      baseline_revision: gitObjectID(cleanString(observation.baseline_revision)) ? cleanString(observation.baseline_revision) : "",
      changed_files: stringArray(observation.changed_files).slice(0, MAX_CHANGED_FILES),
      commit_count: nonNegativeInteger(observation.commit_count),
      commits,
      final_revision: gitObjectID(cleanString(observation.final_revision)) ? cleanString(observation.final_revision) : "",
      has_diff: observation.has_diff === true,
      observed_at: cleanString(observation.observed_at) || event.created_at,
      source: "terminal_observation",
      working_tree_dirty: observation.working_tree_dirty === true
    };
  }
  return null;
}

function gitCommitSummary(repository: string, baseline: string, final: string): CompletionCard["git"]["commits"] {
  if (!gitObjectID(baseline) || !gitObjectID(final)) return [];
  const fields = gitNullList(repository, [
    "log", "--format=%H%x00%cI%x00%s%x00", "-z", `${baseline}..${final}`
  ]);
  const commits: CompletionCard["git"]["commits"] = [];
  for (let index = 0; index + 2 < fields.length && commits.length < MAX_COMMITS; index += 3) {
    commits.push({ revision: fields[index]!, timestamp: fields[index + 1]!, subject: fields[index + 2]! });
  }
  return commits;
}

function completionWarnings(run: IssueRun, commands: CommandObservation[], changedFiles: string[]): string[] {
  const warnings: string[] = [];
  if (commands.length === 0) warnings.push("No terminal command observations were found for the current Run.");
  if (run.git_base_revision !== "" && changedFiles.length === 0) {
    warnings.push("No committed file changes were attributable between the Run baseline and its end time.");
  }
  return warnings;
}

function uniqueCommands(commands: CommandObservation[]): CommandObservation[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = command.id || commandIdentity(command.command, command.exit_code, command.observed_at);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

function boundedSequence<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const first = Math.min(6, Math.floor(limit / 3));
  return [...items.slice(0, first), ...items.slice(-(limit - first))];
}

function gitText(repository: string, args: string[]): string {
  try {
    const result = Bun.spawnSync({ cmd: ["git", ...args], cwd: repository, stderr: "ignore", stdout: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

function gitNullList(repository: string, args: string[]): string[] {
  const output = gitText(repository, args);
  return output.split("\0").map((value) => value.trim()).filter(Boolean);
}

function gitObjectID(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.trim());
}

function commandIdentity(command: string, exitCode: number, observedAt: string): string {
  return createHash("sha256").update(`${command}\0${exitCode}\0${observedAt}`).digest("hex").slice(0, 24);
}

function boundedExcerpt(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const head = boundedUtf8(value, Math.floor(byteLimit * 0.35));
  const tailBytes = Buffer.from(value).subarray(-Math.floor(byteLimit * 0.55));
  return `${head}\n...[truncated]...\n${tailBytes.toString("utf8")}`;
}

function boundedUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= byteLimit) return value;
  return `${bytes.subarray(0, Math.max(0, byteLimit - 16)).toString("utf8")}...[truncated]`;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(cleanString).filter(Boolean))] : [];
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}

export function completionCardRunAttemptID(card: CompletionCard) {
  const runID = makeDomainID("run", "issue_runs", card.run.id);
  return makeRunAttemptID(runID, card.run.attempt);
}
