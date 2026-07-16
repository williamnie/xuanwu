export const SUPERVISOR_CONTROL_TOOL_NAMES = [
  "work_list",
  "work_read",
  "work_create",
  "work_update",
  "work_control",
  "run_list",
  "run_read",
  "run_control",
  "evidence_list",
  "evidence_read",
  "handoff_list",
  "handoff_read"
] as const;

export const SUPERVISOR_CONTROL_READ_TOOL_NAMES = [
  "work_list",
  "work_read",
  "run_list",
  "run_read",
  "evidence_list",
  "evidence_read",
  "handoff_list",
  "handoff_read"
] as const;

export const SUPERVISOR_CONTROL_DANGEROUS_TOOL_NAMES = ["work_control", "run_control"] as const;

export const SUPERVISOR_CONTROL_READ_ACTION_TYPES = [
  "work.list",
  "work.read",
  "run.list",
  "run.read",
  "evidence.list",
  "evidence.read",
  "handoff.list",
  "handoff.read"
] as const;

export const SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES = [
  "work.create",
  "work.update",
  "work.enqueue",
  "work.retry",
  "work.cancel",
  "run.interrupt",
  "run.resume",
  "run.retry"
] as const;

export const SUPERVISOR_CONTROL_HIGH_RISK_ACTION_TYPES = [
  "work.cancel",
  "run.interrupt"
] as const;

export const SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS = 6000;
export const SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS = 1500;

export function supervisorControlOutputSchema(name: string): Record<string, unknown> | undefined {
  if (!SUPERVISOR_CONTROL_TOOL_NAMES.includes(name as typeof SUPERVISOR_CONTROL_TOOL_NAMES[number])) return undefined;
  return {
    additionalProperties: true,
    properties: {
      authority: { type: "string" },
      observed_at: { type: "string" },
      output_budget: {
        properties: {
          max_chars: { const: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS, type: "integer" },
          max_tokens_estimate: { const: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS, type: "integer" }
        },
        required: ["max_chars", "max_tokens_estimate"],
        type: "object"
      }
    },
    required: ["authority", "observed_at", "output_budget"],
    type: "object"
  };
}
