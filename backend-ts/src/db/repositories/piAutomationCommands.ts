import type { RunnerDatabase } from "../database.ts";
import {
  createPiAutomation,
  updatePiAutomation,
  type PiAutomationInput,
  type PiAutomationPatch,
  type PiAutomationRecord
} from "./piAutomations.ts";
import {
  upsertPiAutomationShadow,
  type PiAutomationShadowDisposition
} from "./piAutomationShadow.ts";
import type { AutomationAudit } from "../../domain/automation/contracts.ts";

export const PI_AUTOMATION_SHADOW_ENV = "CODEX_RUNNER_AUTOMATION_SHADOW_W1";
export const PI_AUTOMATION_SHADOW_AUDIT_SCHEMA = "xuanwu.automation-shadow-audit.v1";

export type PiAutomationLegacyCommand =
  | { input: PiAutomationInput; operation: "create" }
  | { id: number; operation: "update"; patch: PiAutomationPatch };

export type PiAutomationLegacyCommandResult = {
  automation: PiAutomationRecord;
  shadow: { enabled: false } | {
    enabled: true;
    error?: string;
    outcome: PiAutomationShadowDisposition | "failed";
  };
};

type ShadowAuditEvent = {
  automation_id: string;
  error: string;
  legacy_id: number;
  operation: PiAutomationLegacyCommand["operation"];
  outcome: "failed";
  schema_version: typeof PI_AUTOMATION_SHADOW_AUDIT_SCHEMA;
  timestamp: string;
};

export function executePiAutomationLegacyCommand(
  db: RunnerDatabase,
  command: PiAutomationLegacyCommand,
  options: {
    auditFailure?: (event: ShadowAuditEvent) => void;
    now?: Date;
    shadowEnabled?: boolean;
    shadowWrite?: typeof upsertPiAutomationShadow;
  } = {}
): PiAutomationLegacyCommandResult {
  const now = options.now ?? new Date();
  // The legacy write intentionally commits first and remains the only result authority in W1.
  const automation = command.operation === "create"
    ? createPiAutomation(db, command.input, now)
    : updatePiAutomation(db, command.id, command.patch, now);
  const enabled = options.shadowEnabled ?? Bun.env[PI_AUTOMATION_SHADOW_ENV] === "1";
  if (!enabled) return { automation, shadow: { enabled: false } };
  try {
    const outcome = (options.shadowWrite ?? upsertPiAutomationShadow)(
      db,
      automation,
      commandAudit(command.operation, automation, now)
    );
    return { automation, shadow: { enabled: true, outcome } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const event: ShadowAuditEvent = {
      automation_id: `automation:legacy-pi-${automation.id}`,
      error: message.slice(0, 1000),
      legacy_id: automation.id,
      operation: command.operation,
      outcome: "failed",
      schema_version: PI_AUTOMATION_SHADOW_AUDIT_SCHEMA,
      timestamp: now.toISOString()
    };
    (options.auditFailure ?? defaultAuditFailure)(event);
    return { automation, shadow: { enabled: true, error: event.error, outcome: "failed" } };
  }
}

function commandAudit(
  operation: PiAutomationLegacyCommand["operation"],
  automation: PiAutomationRecord,
  now: Date
): AutomationAudit {
  const identity = `${automation.id}:${now.toISOString()}`;
  return {
    actor_id: "pi-automation-command-seam",
    actor_kind: "system",
    correlation_id: `legacy-pi-automation:${operation}:${identity}`,
    event_id: `automation-shadow:${operation}:${identity}`,
    gate: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: "automation-shadow-w1:legacy-primary:v1"
    },
    occurred_at: now.toISOString(),
    reason: `W1 ${operation} target shadow after successful legacy pi_automations write`
  };
}

function defaultAuditFailure(event: ShadowAuditEvent): void {
  console.warn(JSON.stringify(event));
}
