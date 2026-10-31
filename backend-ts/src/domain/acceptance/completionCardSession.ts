import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { type IssueRun } from "../../db/repositories/issues.ts";
import { codexDynamicExecObservation } from "../../providers/codex/dynamicExec.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import {
  type CompletionCardSessionInput,
  type CompletionCardSession,
  boundedUtf8,
  stableJson,
  type CompletionCardSessionItem,
  boundedSequence,
  integer,
  MAX_COMMAND_BYTES,
  boundedExcerpt,
  MAX_OUTPUT_BYTES,
  parseJson,
  MAX_FINAL_MESSAGE_BYTES
} from "./completionCardModel.ts";
import { liveGitSummary } from "./completionCardGit.ts";
import { commandText } from "./completionCardCommands.ts";
import { eventBelongsToRun } from "./completionCardReview.ts";

export async function completionSession(
  repository: string,
  run: IssueRun,
  input: CompletionCardSessionInput | undefined
): Promise<CompletionCardSession> {
  const summary = input?.summary ?? {};
  const turns = Array.isArray(summary.turns) ? summary.turns.map(objectValue) : [];
  const latest = [...turns].reverse().find((turn) => sessionTurnID(turn) !== "") ?? {};
  const latestTurnID = sessionTurnID(latest);
  const matches = latestTurnID !== "" && latestTurnID === run.provider_turn_id;
  const newer = latestTurnID !== "" && !matches;
  return {
    current_git: newer ? await liveGitSummary(repository, run, sessionObservedAt(summary, latest, run)) : null,
    error: boundedUtf8(redactSensitiveText(cleanString(input?.error)), 1_000),
    inspected: input !== undefined,
    latest_turn_id: latestTurnID,
    latest_turn_items: sessionTurnItems(latest),
    latest_turn_matches_run: matches,
    latest_turn_status: sessionTurnStatus(latest),
    provider_session_id: run.provider_session_id,
    run_turn_id: run.provider_turn_id,
    turn_count: turns.length
  };
}

function sessionObservedAt(
  summary: Record<string, unknown>,
  latestTurn: Record<string, unknown>,
  run: IssueRun
): string {
  for (const value of [
    latestTurn.completedAt,
    latestTurn.completed_at,
    latestTurn.updatedAt,
    latestTurn.updated_at,
    summary.updatedAt,
    summary.updated_at
  ]) {
    const timestamp = normalizedTimestamp(value);
    if (timestamp !== "") return timestamp;
  }
  return run.ended_at;
}

function normalizedTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value >= 1_000_000_000_000 ? value : value * 1_000;
    const timestamp = new Date(milliseconds);
    return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
  }
  const text = cleanString(value);
  if (text === "") return "";
  const timestamp = new Date(text);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
}

function sessionTurnID(turn: Record<string, unknown>): string {
  return cleanString(turn.id) || cleanString(turn.turn_id) || cleanString(turn.turnId);
}

function sessionTurnStatus(turn: Record<string, unknown>): string {
  const status = turn.status;
  if (typeof status === "string") return boundedUtf8(status.trim(), 200);
  if (status && typeof status === "object") return boundedUtf8(stableJson(status), 200);
  return "";
}

function sessionTurnItems(turn: Record<string, unknown>): CompletionCardSessionItem[] {
  const items = Array.isArray(turn.items) ? turn.items.map(objectValue) : [];
  return boundedSequence(items, 24).map((item) => {
    const dynamic = codexDynamicExecObservation(item);
    const exitCode = dynamic?.exitCode ?? integer(item.exitCode);
    const output = dynamic?.aggregatedOutput || cleanString(item.aggregatedOutput)
      || [cleanString(item.stdout), cleanString(item.stderr)].filter(Boolean).join("\n");
    return {
      command: boundedUtf8(redactSensitiveText(dynamic?.command || commandText(item)), MAX_COMMAND_BYTES),
      exit_code: exitCode,
      output_excerpt: boundedExcerpt(redactSensitiveText(output), MAX_OUTPUT_BYTES),
      status: boundedUtf8(cleanString(item.status), 200),
      text: boundedUtf8(redactSensitiveText(sessionItemText(item)), 2_000),
      type: boundedUtf8(cleanString(item.type) || "unknown", 200)
    };
  });
}

function sessionItemText(item: Record<string, unknown>): string {
  const direct = cleanString(item.text) || cleanString(item.message);
  if (direct !== "") return direct;
  if (typeof item.content === "string") return item.content.trim();
  if (!Array.isArray(item.content)) return "";
  return item.content.map((value) => {
    const content = objectValue(value);
    return cleanString(content.text) || cleanString(content.content);
  }).filter(Boolean).join("\n");
}

export function latestFinalMessage(events: ReturnType<typeof listIssueEvents>, run: IssueRun): string {
  const messages = events.flatMap((event) => {
    if (event.type !== "issue.log") return [];
    const payload = objectValue(parseJson(event.payload));
    if (!eventBelongsToRun(payload, event.created_at, run)) return [];
    const text = cleanString(payload.text);
    return text === "" ? [] : [text];
  });
  return boundedUtf8(messages.at(-1) ?? "", MAX_FINAL_MESSAGE_BYTES);
}

export function providerOutcome(events: ReturnType<typeof listIssueEvents>, run: IssueRun): { outcome: string; reason: string } {
  for (const event of [...events].reverse()) {
    if (event.type !== "issue.runner_outcome") continue;
    const payload = objectValue(parseJson(event.payload));
    if (cleanString(payload.issue_run_id) !== run.id) continue;
    return { outcome: cleanString(payload.outcome), reason: cleanString(payload.reason) };
  }
  return { outcome: "unknown", reason: "" };
}
