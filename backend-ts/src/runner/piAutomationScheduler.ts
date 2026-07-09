import type { RunnerDatabase } from "../db/database.ts";
import {
  claimDuePiAutomations,
  recordPiAutomationFailure,
  recordPiAutomationSuccess
} from "../db/repositories/piAutomationScheduler.ts";
import type { PiAutomationRecord } from "../db/repositories/piAutomations.ts";
import { runPiAutomationPipeline } from "../pi/automationRunner.ts";

export type PiAutomationRunResult = {
  detail?: string;
  lastSuccessfulCursor?: string;
  processedWatermark?: string;
};
export type PiAutomationExecutor = (
  automation: PiAutomationRecord,
  context: { database: RunnerDatabase; now: Date }
) => Promise<PiAutomationRunResult | void>;

export type PiAutomationSchedulerResult = {
  executed: number;
  failed: number;
  scanned: number;
  skipped: number;
};

export type PiAutomationSchedulerInput = {
  database: RunnerDatabase;
  executeAutomation?: PiAutomationExecutor;
  limit?: number;
  now?: Date;
};

export async function runDuePiAutomations(input: PiAutomationSchedulerInput): Promise<PiAutomationSchedulerResult> {
  const now = input.now ?? new Date();
  const automations = claimDuePiAutomations(input.database, now, input.limit);
  const result: PiAutomationSchedulerResult = { executed: 0, failed: 0, scanned: automations.length, skipped: 0 };
  for (const automation of automations) {
    try {
      const output = await runWithTimeout(executor(input), automation, input.database, now);
      recordPiAutomationSuccess(input.database, automation, now, {
        detail: output?.detail,
        lastSuccessfulCursor: output?.lastSuccessfulCursor,
        processedWatermark: output?.processedWatermark
      });
      result.executed += 1;
    } catch (error) {
      recordPiAutomationFailure(input.database, automation, now, {
        detail: safeError(error),
        failedCursor: errorCursor(error)
      });
      result.failed += 1;
    }
  }
  return result;
}

async function runWithTimeout(
  execute: PiAutomationExecutor,
  automation: PiAutomationRecord,
  database: RunnerDatabase,
  now: Date
): Promise<PiAutomationRunResult | void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("automation run timeout")), automation.run_timeout_ms);
  });
  try {
    return await Promise.race([execute(automation, { database, now }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function executor(input: PiAutomationSchedulerInput): PiAutomationExecutor {
  return input.executeAutomation ?? defaultExecutor;
}

async function defaultExecutor(
  automation: PiAutomationRecord,
  context: { database: RunnerDatabase; now: Date }
): Promise<PiAutomationRunResult> {
  return runPiAutomationPipeline(automation, context);
}

function errorCursor(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const cursor = (error as { failed_cursor?: unknown; failedCursor?: unknown }).failed_cursor
    ?? (error as { failedCursor?: unknown }).failedCursor;
  return typeof cursor === "string" ? cursor : undefined;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
