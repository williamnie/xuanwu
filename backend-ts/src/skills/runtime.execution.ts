import type { AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/tools/toolRegistrySnapshot.ts";
import { BUILTIN_DOMAIN_PROPOSAL_HANDLER, runBuiltinDomainProposalSkill } from "./builtinDomainProposal.ts";
import { cleanString } from "../util/values.ts";
import { SKILL_RUNTIME_STARTED_EVENT, SkillRuntimeError, SKILL_RUNTIME_COMPLETED_EVENT } from "./runtime.model.ts";
import type { SkillRuntimeHandler, ExecuteSkillRuntimeInput, SkillRuntimeResult, SkillRuntimeRun } from "./runtime.model.ts";
import { recordValue, sortedUnique, inputEvidenceRefs, positiveInteger, deepFreeze, actionCount } from "./runtime.values.ts";
import { auditContext, recordRunEvent, normalizeFailure } from "./runtime.audit.ts";
import { validateWorkflowBoundary, validateToolGrants, invokeGrantedTool } from "./runtime.tools.ts";
import { validateSchema } from "./runtime.schema.ts";
import { validateEvidenceBinding } from "./runtime.evidence.ts";

export const BUILTIN_HANDLERS: Readonly<Record<string, SkillRuntimeHandler>> = {
  [BUILTIN_DOMAIN_PROPOSAL_HANDLER]: (input, context) => runBuiltinDomainProposalSkill(
    recordValue(input.inbox_item) as unknown as AttentionInboxItemRecord,
    context.skillID
  )
};

export function hasBuiltinSkillHandler(handler: string): boolean {
  return Object.hasOwn(BUILTIN_HANDLERS, handler);
}

export async function executeSkillRuntime<TOutput = unknown>(
  input: ExecuteSkillRuntimeInput
): Promise<SkillRuntimeResult<TOutput>> {
  const startedAt = new Date();
  const execution = input.skill.execution;
  const audit = auditContext(input);
  const evidenceRefs = sortedUnique(input.evidenceRefs ?? inputEvidenceRefs(input.input));
  const inputItem = recordValue(input.input.inbox_item);
  const base = {
    contract: "xw.skill-run.v1",
    evidence_refs: evidenceRefs,
    handler: execution?.handler ?? "",
    input_object: input.skill.input_object ?? "",
    item_id: positiveInteger(inputItem.id),
    kind: input.skill.kind ?? "",
    manifest_path: input.skill.runtime_manifest_path ?? "",
    run_id: input.runID,
    sandbox: execution?.sandbox ?? "",
    skill_id: input.skill.id,
    primary_intent: cleanString(inputItem.primary_intent),
    timeout_ms: execution?.timeout_ms ?? 0,
    tool_grants: [...input.skill.required_tools],
    workflow_ref: input.workflow?.manifest_ref ?? "",
    workflow_stage_id: input.workflow?.stage.id ?? ""
  };
  recordRunEvent(input.db, audit, input.runID, SKILL_RUNTIME_STARTED_EVENT, "running", {
    ...base,
    input_validation: "pending",
    output_validation: "pending"
  });

  const controller = new AbortController();
  let active = true;
  try {
    if (!execution) throw new SkillRuntimeError("runtime_not_executable", `skill ${input.skill.id} has no executable runtime`);
    const handler = BUILTIN_HANDLERS[execution.handler] ?? input.handlers?.[execution.handler];
    if (!handler) throw new SkillRuntimeError("handler_not_allowed", `skill handler is not allowlisted: ${execution.handler}`);
    validateWorkflowBoundary(input.skill, input.workflow);
    validateSchema(input.skill.input_schema, input.input, "input");
    const snapshot = input.toolSnapshot ?? loadAssistantToolRegistrySnapshot(input.db, {
      cliConnectorDirs: input.cliConnectorDirs ?? [],
      env: input.env
    });
    validateToolGrants(input.skill, snapshot, input.workflow);
    const frozenInput = deepFreeze(structuredClone(input.input));
    const output = await withTimeout(
      () => handler(frozenInput, {
        abortSignal: controller.signal,
        invokeTool: (grant, params = {}) => invokeGrantedTool(input, snapshot, audit, grant, params, () => active),
        skillID: input.skill.id
      }),
      execution.timeout_ms,
      controller
    );
    validateSchema(input.skill.output_schema, output, "output");
    validateEvidenceBinding(input.skill, frozenInput, output);
    const run: SkillRuntimeRun = {
      evidence_refs: evidenceRefs,
      handler: execution.handler,
      run_id: input.runID,
      sandbox: execution.sandbox,
      skill_id: input.skill.id,
      status: "succeeded",
      timeout_ms: execution.timeout_ms,
      tool_grants: [...input.skill.required_tools],
      workflow_ref: input.workflow?.manifest_ref ?? "",
      workflow_stage_id: input.workflow?.stage.id ?? ""
    };
    recordRunEvent(input.db, audit, input.runID, SKILL_RUNTIME_COMPLETED_EVENT, "succeeded", {
      ...base,
      action_count: actionCount(output),
      duration_ms: Math.max(0, Date.now() - startedAt.getTime()),
      evidence_validation: "passed",
      input_validation: "passed",
      output_validation: "passed"
    });
    return { output: output as TOutput, run };
  } catch (error) {
    const failure = normalizeFailure(error);
    recordRunEvent(input.db, audit, input.runID, SKILL_RUNTIME_COMPLETED_EVENT, failure.status, {
      ...base,
      duration_ms: Math.max(0, Date.now() - startedAt.getTime()),
      error_code: failure.code,
      input_validation: failure.code === "input_schema_invalid" ? "failed" : "unknown",
      output_validation: failure.code === "output_schema_invalid" ? "failed" : "unknown"
    }, failure.message);
    throw error instanceof SkillRuntimeError ? error : new SkillRuntimeError(failure.code, failure.message);
  } finally {
    active = false;
    controller.abort();
  }
}

export async function withTimeout(
  run: () => Promise<unknown> | unknown,
  timeoutMs: number,
  controller: AbortController
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new SkillRuntimeError("skill_timeout", `skill runtime timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
