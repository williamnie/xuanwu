import { createHash } from "node:crypto";
import { runGit } from "../run/gitWorkspaceObservation.ts";
import { type PriorExecutionEvidence } from "./priorExecutionEvidence.ts";
import { cleanString } from "../../util/values.ts";

export const COMPLETION_CARD_CONTRACT = "xw.issue-completion-card.v1" as const;

export const COMPLETION_CARD_EVENT_TYPE = "issue.completion_card.v1";

export const COMPLETION_GIT_OBSERVATION_CONTRACT = "xw.issue-completion-git-observation.v1" as const;

export const COMPLETION_GIT_OBSERVATION_EVENT_TYPE = "issue.completion_git_observation.v1";

export const TERMINAL_COMMAND_OBSERVATION_CONTRACT = "xw.all-terminal-command-observations.v1" as const;

export type CompletionCardCommand = {
  source_event_ref?: string;
  source_run_id?: string;
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

export type CompletionCardGit = {
  baseline_revision: string;
  changed_files: string[];
  commit_count: number;
  commits: Array<{ revision: string; subject: string; timestamp: string }>;
  final_revision: string;
  has_diff: boolean;
  observed_at: string;
  source: "legacy_reconstruction" | "session_observation" | "terminal_observation";
  working_tree_dirty: boolean;
  workspace_snapshot_ref?: string;
};

export type CompletionCardSessionItem = {
  command: string;
  exit_code: number | null;
  output_excerpt: string;
  status: string;
  text: string;
  type: string;
};

export type CompletionCardSession = {
  current_git: CompletionCardGit | null;
  error: string;
  inspected: boolean;
  latest_turn_id: string;
  latest_turn_items: CompletionCardSessionItem[];
  latest_turn_matches_run: boolean;
  latest_turn_status: string;
  provider_session_id: string;
  run_turn_id: string;
  turn_count: number;
};

export type CompletionCardSessionInput = {
  error?: string;
  summary?: Record<string, unknown>;
};

type CompletionCardRun = {
  attempt: number;
  ended_at: string;
  id: string;
  provider: string;
  provider_session_id: string;
  provider_turn_id: string;
  started_at: string;
  status: string;
};

export type CompletionCardHumanReview = {
  action: string;
  answered_at: string;
  comment: string;
  intervening_runs: Array<{
    attempt: number;
    control_operation: string;
    control_outcome: string;
    ended_at: string;
    error: string;
    exit_reason: string;
    id: string;
    status: string;
  }>;
  origin_card_fingerprint: string;
  origin_completion: null | {
    commands: { items: CompletionCardCommand[]; omitted: number; total: number };
    final_message: string;
    git: CompletionCardGit;
    provider_outcome: { outcome: string; reason: string };
    run: CompletionCardRun;
    warnings: string[];
  };
  origin_run_id: string;
  request: {
    acceptance_summary: string[];
    consequences: string;
    evidence_refs: string[];
    excluded_scope: string[];
    kind: "acceptance" | "decision" | "risk_acceptance";
    question: string;
    recommendation: string;
  };
  request_id: string;
  review_revision: number;
};

export type CompletionCard = {
  prior_evidence?: PriorExecutionEvidence;
  acceptance: {
    criteria: Array<{ description: string; id: string; required: boolean }>;
  };
  commands: {
    items: CompletionCardCommand[];
    omitted: number;
    total: number;
  };
  contract: typeof COMPLETION_CARD_CONTRACT;
  final_message: string;
  fingerprint: string;
  generated_at: string;
  git: CompletionCardGit;
  human_review: CompletionCardHumanReview | null;
  issue: {
    id: number;
    project_id: string;
    status: string;
    title: string;
    updated_at: string;
    goal: string;
  };
  provider_outcome: { outcome: string; reason: string };
  run: CompletionCardRun;
  session: CompletionCardSession;
  warnings: string[];
};

export type CommandObservation = Omit<CompletionCardCommand, "sequence">;

export const MAX_COMMANDS = 36;

export const MAX_COMMAND_BYTES = 2_000;

export const MAX_OUTPUT_BYTES = 1_200;

export const MAX_FINAL_MESSAGE_BYTES = 8_000;

export const MAX_CHANGED_FILES = 200;

export const MAX_COMMITS = 20;

export function boundedSequence<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  const first = Math.min(6, Math.floor(limit / 3));
  return [...items.slice(0, first), ...items.slice(-(limit - first))];
}

export async function gitText(repository: string, args: string[], deadline: number, requireSuccess = false): Promise<string> {
  const result = await runGit(repository, args, deadline);
  if (!result && requireSuccess) throw new Error("Git workspace observation failed or exceeded its budget");
  return result ? new TextDecoder().decode(result.stdout).trim() : "";
}

export async function gitNullList(repository: string, args: string[], deadline: number, requireSuccess = false): Promise<string[]> {
  const output = await gitText(repository, args, deadline, requireSuccess);
  return output.split("\0").map((value) => value.trim()).filter(Boolean);
}

export function gitObjectID(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(value.trim());
}

export function commandIdentity(command: string, exitCode: number, observedAt: string): string {
  return createHash("sha256").update(`${command}\0${exitCode}\0${observedAt}`).digest("hex").slice(0, 24);
}

export function boundedExcerpt(value: string, byteLimit: number): string {
  if (Buffer.byteLength(value) <= byteLimit) return value;
  const head = boundedUtf8(value, Math.floor(byteLimit * 0.35));
  const tailBytes = Buffer.from(value).subarray(-Math.floor(byteLimit * 0.55));
  return `${head}\n...[truncated]...\n${tailBytes.toString("utf8")}`;
}

export function boundedUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= byteLimit) return value;
  return `${bytes.subarray(0, Math.max(0, byteLimit - 16)).toString("utf8")}...[truncated]`;
}

export function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return {};
  }
}

export function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(cleanString).filter(Boolean))] : [];
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}
