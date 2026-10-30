import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { type IssueRun } from "../../db/repositories/issues.ts";
import { codexDynamicExecObservation } from "../../providers/codex/dynamicExec.ts";
import { recoverCodexRolloutExecEvents } from "../../providers/codex/rolloutExecRecovery.ts";
import { TOOL_OBSERVATION_SCHEMA_VERSION } from "../../runner/issueLogPersistence.ts";
import { cleanString, nonNegativeInteger, objectValue } from "../../util/values.ts";
import {
  type CommandObservation,
  parseJson,
  integer,
  boundedUtf8,
  MAX_COMMAND_BYTES,
  commandIdentity,
  boundedExcerpt,
  MAX_OUTPUT_BYTES
} from "./completionCardModel.ts";
import { eventBelongsToRun } from "./completionCardReview.ts";

export function commandsFromIssueLogs(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): CommandObservation[] {
  const output: CommandObservation[] = [];
  for (const event of events) {
    if (event.type !== "issue.log") continue;
    const payload = objectValue(parseJson(event.payload));
    if (!eventBelongsToRun(payload, event.created_at, run)) continue;
    const item = commandItemFromIssueLog(payload);
    const observation = commandObservation(item, event.created_at, "issue_log");
    if (observation) {
      const correlatedRun = cleanString(objectValue(payload.runtime_evidence_correlation).issue_run_id);
      output.push({ ...observation, ...(correlatedRun === run.id
        ? { source_event_ref: `event:${event.id}`, source_run_id: run.id } : {}) });
    }
  }
  return output;
}

function commandItemFromIssueLog(payload: Record<string, unknown>): Record<string, unknown> {
  const stored = objectValue(payload.payload);
  if (cleanString(stored.schema_version) === TOOL_OBSERVATION_SCHEMA_VERSION &&
      cleanString(stored.representation) === "terminal_tool_observation") {
    return {
      aggregatedOutput: cleanString(stored.output_excerpt) || cleanString(payload.text),
      command: cleanString(payload.command),
      cwd: cleanString(stored.cwd),
      durationMs: nonNegativeInteger(stored.duration_ms),
      exitCode: integer(stored.exit_code),
      id: cleanString(stored.item_id),
      status: cleanString(payload.status),
      type: "commandExecution"
    };
  }
  return objectValue(objectValue(parseJson(payload.raw_payload)).item);
}

export async function recoveredRolloutCommands(run: IssueRun): Promise<CommandObservation[]> {
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

export function commandText(item: Record<string, unknown>): string {
  const direct = cleanString(item.command);
  if (direct !== "") return direct;
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  return actions.map((action) => cleanString(objectValue(action).command)).filter(Boolean).join(" && ");
}

export function uniqueCommands(commands: CommandObservation[]): CommandObservation[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = command.id || commandIdentity(command.command, command.exit_code, command.observed_at);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}
