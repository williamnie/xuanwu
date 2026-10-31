import type { RunnerDatabase } from "../db/database.ts";
import type { EventBus } from "../events/bus.ts";
import { type ToolCallAuditContext } from "../pi/actions/toolCallAudit.ts";
import { type AssistantToolRegistrySnapshot } from "../pi/tools/toolRegistrySnapshot.ts";
import type { WorkflowStage } from "../workflows/manifest.ts";
import type { SkillMetadata } from "./registry.ts";
import type { auditContext } from "./runtime.audit.ts";

export type JsonObject = Record<string, unknown>;

export type SkillRuntimeHandlerContext = {
  abortSignal: AbortSignal;
  invokeTool: (grant: string, input?: JsonObject) => Promise<unknown>;
  skillID: string;
};

export type SkillRuntimeHandler = (
  input: Readonly<JsonObject>,
  context: SkillRuntimeHandlerContext
) => Promise<unknown> | unknown;

export type SkillRuntimeWorkflowContext = {
  manifest_ref: string;
  stage: WorkflowStage;
};

export type ExecuteSkillRuntimeInput = {
  auditContext?: Partial<ToolCallAuditContext>;
  bus?: EventBus;
  cliConnectorDirs?: string[];
  db: RunnerDatabase;
  env?: Record<string, string | undefined>;
  evidenceRefs?: string[];
  handlers?: Readonly<Record<string, SkillRuntimeHandler>>;
  input: JsonObject;
  runID: string;
  skill: SkillMetadata;
  toolSnapshot?: AssistantToolRegistrySnapshot;
  workflow?: SkillRuntimeWorkflowContext;
};

export type SkillRuntimeRun = {
  evidence_refs: string[];
  handler: string;
  run_id: string;
  sandbox: "capability";
  skill_id: string;
  status: "succeeded";
  timeout_ms: number;
  tool_grants: string[];
  workflow_ref: string;
  workflow_stage_id: string;
};

export type SkillRuntimeResult<TOutput = unknown> = {
  output: TOutput;
  run: SkillRuntimeRun;
};

export class SkillRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillRuntimeError";
  }
}

export const SKILL_RUNTIME_STARTED_EVENT = "skill_runtime.started";

export const SKILL_RUNTIME_COMPLETED_EVENT = "skill_runtime.completed";
