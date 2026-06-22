import type { RunnerDatabase } from "../db/database.ts";
import {
  listPiActions,
  updatePiAction,
  type PiAction
} from "../db/repositories/pi.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import {
  dispatchPiAction,
  type PiActionDispatchContext
} from "../http/piActionDispatch.ts";
import { recordPiActionAuditEvent } from "../pi/actionEngine.ts";

export type PiGuardianActionDispatchInput = {
  database: RunnerDatabase;
  limit?: number;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type PiGuardianActionDispatchResult = {
  completed: number;
  failed: number;
  scanned: number;
  skipped: number;
};

const DEFAULT_LIMIT = 20;
const EXECUTABLE_ACTIONS = new Set(["issue.retry", "issue.retry_after", "session.resume_followup"]);

export async function dispatchApprovedGuardianActions(
  input: PiGuardianActionDispatchInput
): Promise<PiGuardianActionDispatchResult> {
  const actions = executableActions(input.database, input.limit ?? DEFAULT_LIMIT);
  const result: PiGuardianActionDispatchResult = { completed: 0, failed: 0, scanned: actions.length, skipped: 0 };
  for (const action of actions) {
    const next = await dispatchOne(input, action);
    result[next] += 1;
  }
  return result;
}

async function dispatchOne(
  input: PiGuardianActionDispatchInput,
  action: PiAction
): Promise<"completed" | "failed" | "skipped"> {
  if (!ready(action)) return "skipped";
  const executing = updatePiAction(input.database, action.id, { status: "executing" });
  recordPiActionAuditEvent(input.database, executing, "execution_started", { actor: "guardian_dispatcher", decision: "execute" });
  try {
    const result = await dispatchPiAction(dispatchContext(input), executing);
    const completed = updatePiAction(input.database, action.id, { result_json: JSON.stringify(result ?? null), status: "completed" });
    recordPiActionAuditEvent(input.database, completed, "execution_result", { actor: "executor", result });
    return "completed";
  } catch (error) {
    const failed = updatePiAction(input.database, action.id, { result_json: JSON.stringify({ error: safeError(error) }), status: "failed" });
    recordPiActionAuditEvent(input.database, failed, "execution_error", { actor: "executor", error: safeError(error) });
    return "failed";
  }
}

function executableActions(db: RunnerDatabase, limit: number): PiAction[] {
  return listPiActions(db, { status: "approved" })
    .filter((action) => ready(action))
    .slice(0, boundedLimit(limit));
}

function ready(action: PiAction): boolean {
  return action.source === "pi_guardian_orchestrator" &&
    action.gate_decision === "execute" &&
    EXECUTABLE_ACTIONS.has(action.action_type);
}

function dispatchContext(input: PiGuardianActionDispatchInput): PiActionDispatchContext {
  return { database: input.database, providers: input.providers };
}

function boundedLimit(value: number): number {
  return Math.min(Math.max(Number.isFinite(value) ? Math.round(value) : DEFAULT_LIMIT, 1), DEFAULT_LIMIT);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
