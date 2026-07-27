import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { invokeReadOnlyAssistantTool } from "../pi/readOnlyToolInvocation.ts";
import { createPiMcpActions } from "../pi/mcpActionTools.ts";
import { executeSafePiAction } from "../pi/actionEngine.ts";
import { createPiProjectTools } from "../http/piProjectTools.ts";
import type { EventBus } from "../events/bus.ts";
import { recordToolCallAuditEvent, type ToolCallAuditContext } from "../pi/toolCallAudit.ts";
import { loadAssistantToolRegistrySnapshot, type AssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import type { AssistantTool, ToolPermission } from "../pi/toolProviderEnvelope.ts";
import type { WorkflowStage } from "../workflows/manifest.ts";
import {
  BUILTIN_DOMAIN_PROPOSAL_HANDLER,
  runBuiltinDomainProposalSkill
} from "./builtinDomainProposal.ts";
import type { SkillMetadata } from "./registry.ts";

type JsonObject = Record<string, unknown>;

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

const TOOL_PERMISSIONS: ToolPermission[] = ["read", "write", "dangerous"];
const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$id", "$schema", "additionalProperties", "allOf", "anyOf", "const", "default", "description", "enum",
  "examples", "items", "maxItems", "maxLength", "maximum", "minItems", "minLength", "minimum", "oneOf",
  "pattern", "properties", "required", "title", "type"
]);
const BUILTIN_HANDLERS: Readonly<Record<string, SkillRuntimeHandler>> = {
  [BUILTIN_DOMAIN_PROPOSAL_HANDLER]: (input, context) => runBuiltinDomainProposalSkill(
    recordValue(input.inbox_item) as unknown as AttentionInboxItemRecord,
    context.skillID
  )
};

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

async function invokeGrantedTool(
  input: ExecuteSkillRuntimeInput,
  snapshot: AssistantToolRegistrySnapshot,
  audit: ToolCallAuditContext,
  grant: string,
  params: JsonObject,
  isActive: () => boolean
): Promise<unknown> {
  const invocationID = `skill:${safeID(input.runID)}:${crypto.randomUUID()}`;
  if (!isActive()) throw new SkillRuntimeError("skill_run_closed", "skill run is no longer active");
  const tool = resolveGrantedTool(input.skill.required_tools, snapshot.tools, grant);
  if (!tool) return denyTool(input.db, audit, invocationID, grant, params, "tool_not_granted", `tool is outside skill grants: ${grant}`);
  const max = effectiveMaxPermission(input.skill, input.workflow);
  if (permissionRank(tool.permission) > permissionRank(max)) {
    return denyTool(input.db, audit, invocationID, grant, params, "permission_denied", `tool ${grant} exceeds ${max} permission`);
  }
  if (tool.permission !== "read") {
    return await invokeGovernedSkillTool(input, snapshot, audit, tool, params, invocationID);
  }
  const result = await invokeReadOnlyAssistantTool({
    auditContext: audit,
    db: input.db,
    env: input.env,
    input: params,
    invocationID,
    manifestDirs: input.cliConnectorDirs,
    projectID: audit.projectID,
    providerID: tool.provider_id,
    timeoutMs: tool.timeout_ms,
    toolName: tool.name
  });
  if (result.status !== "succeeded") {
    throw new SkillRuntimeError(result.error?.code || `tool_${result.status}`, result.error?.message || `tool ${grant} ${result.status}`);
  }
  return result.output;
}

async function invokeGovernedSkillTool(
  input: ExecuteSkillRuntimeInput,
  snapshot: AssistantToolRegistrySnapshot,
  audit: ToolCallAuditContext,
  tool: AssistantTool,
  params: JsonObject,
  invocationID: string
): Promise<unknown> {
  const provider = snapshot.providers.find((item) => item.id === tool.provider_id);
  const context = {
    bus: input.bus,
    conversationID: audit.conversationID,
    delegationID: audit.delegationID,
    heartbeatID: audit.heartbeatID,
    issueID: audit.issueID,
    projectID: audit.projectID,
    source: `skill_runtime:${input.skill.id}`
  };
  if (provider?.kind === "builtin") {
    const project = audit.projectID ? getProject(input.db, audit.projectID) ?? undefined : undefined;
    const definition = createPiProjectTools(input.db, project, context).find((item) => item.name === tool.name);
    if (!definition) {
      return denyTool(input.db, audit, invocationID, tool.name, params, "handler_not_allowed", `builtin tool is not governed: ${tool.name}`);
    }
    const result = await definition.execute(invocationID, params, undefined, undefined, {} as never);
    return recordValue(result).details ?? result;
  }
  if (provider?.kind === "mcp") {
    const capabilityID = cleanString(tool.metadata?.capability_id);
    if (capabilityID === "") {
      return denyTool(input.db, audit, invocationID, tool.name, params, "tool_not_granted", "MCP capability id is missing");
    }
    return await createPiMcpActions(input.db, context).callMcpTool({ capability_id: capabilityID, input: params });
  }
  return await executeSafePiAction(input.db, context, {
    actionType: "assistant.tool.call",
    payload: {
      input: params,
      manifest_dirs: input.cliConnectorDirs ?? [],
      permission: tool.permission,
      provider_id: tool.provider_id,
      tool_name: tool.name
    },
    issueID: audit.issueID,
    projectID: audit.projectID,
    riskOverride: { requiresConfirmation: true, riskLevel: "high" },
    execute: () => invokeReadOnlyAssistantTool({
      auditContext: audit,
      db: input.db,
      env: input.env,
      input: params,
      invocationID,
      manifestDirs: input.cliConnectorDirs,
      maxPermission: tool.permission,
      projectID: audit.projectID,
      providerID: tool.provider_id,
      toolName: tool.name
    })
  });
}

function denyTool(
  db: RunnerDatabase,
  audit: ToolCallAuditContext,
  invocationID: string,
  grant: string,
  params: JsonObject,
  code: string,
  message: string
): never {
  recordToolCallAuditEvent(db, audit, {
    args: params,
    durationMs: 0,
    error: { message, type: code },
    providerID: "skill-runtime",
    status: "denied",
    toolCallID: invocationID,
    toolName: grant
  });
  throw new SkillRuntimeError(code, message);
}

function validateWorkflowBoundary(skill: SkillMetadata, workflow: SkillRuntimeWorkflowContext | undefined): void {
  if (!workflow) return;
  if (!workflow.stage.agent.required_skill_ids.includes(skill.id)) {
    throw new SkillRuntimeError("workflow_skill_denied", `workflow stage does not require skill ${skill.id}`);
  }
  if (permissionRank(skillMaxPermission(skill)) > permissionRank(workflow.stage.permissions.max_tool_permission)) {
    throw new SkillRuntimeError("workflow_permission_denied", `skill permission exceeds workflow stage ceiling`);
  }
  for (const grant of skill.required_tools) {
    if (!workflow.stage.permissions.allowed_tools.includes(grant)) {
      throw new SkillRuntimeError("workflow_tool_denied", `skill tool is outside workflow stage allowlist: ${grant}`);
    }
  }
}

function validateToolGrants(
  skill: SkillMetadata,
  snapshot: AssistantToolRegistrySnapshot,
  workflow: SkillRuntimeWorkflowContext | undefined
): void {
  const max = effectiveMaxPermission(skill, workflow);
  for (const grant of skill.required_tools) {
    const tool = resolveTool(snapshot.tools, grant);
    if (!tool) throw new SkillRuntimeError("required_tool_missing", `required tool missing: ${grant}`);
    if (permissionRank(tool.permission) > permissionRank(max)) {
      throw new SkillRuntimeError("permission_conflict", `required tool ${grant} exceeds ${max} permission`);
    }
  }
}

function resolveGrantedTool(grants: string[], tools: AssistantTool[], requested: string): AssistantTool | undefined {
  const requestedTool = resolveTool(tools, requested);
  if (!requestedTool) return undefined;
  const granted = grants.some((grant) => toolMatches(requestedTool, grant));
  return granted ? requestedTool : undefined;
}

function resolveTool(tools: AssistantTool[], id: string): AssistantTool | undefined {
  const matches = tools.filter((tool) => toolMatches(tool, id));
  return matches.length === 1 ? matches[0] : undefined;
}

function toolMatches(tool: AssistantTool, id: string): boolean {
  const aliases = [cleanString(tool.metadata?.capability_id)].filter(Boolean);
  return tool.name === id || `${tool.provider_id}:${tool.name}` === id || aliases.includes(id);
}

function validateSchema(schema: JsonObject | undefined, value: unknown, direction: "input" | "output"): void {
  if (!schema) throw new SkillRuntimeError(`${direction}_schema_missing`, `skill ${direction} schema is missing`);
  const errors = jsonSchemaErrors(schema, value).slice(0, 6);
  if (errors.length === 0) return;
  throw new SkillRuntimeError(
    `${direction}_schema_invalid`,
    `skill ${direction} failed schema validation: ${errors.join("; ")}`
  );
}

function jsonSchemaErrors(schema: JsonObject | boolean, value: unknown, path = "$", depth = 0): string[] {
  if (depth > 32) return [`${path}: schema nesting exceeds 32 levels`];
  if (schema === true) return [];
  if (schema === false) return [`${path}: value is not allowed`];
  const errors = schemaShapeErrors(schema, path);
  if (errors.length > 0) return errors;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(`${path}: must match enum`);
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) errors.push(`${path}: must match const`);
  const types = Array.isArray(schema.type) ? stringList(schema.type) : [cleanString(schema.type)].filter(Boolean);
  if (types.length > 0 && !types.some((type) => jsonTypeMatches(type, value))) {
    errors.push(`${path}: must be ${types.join(" or ")}`);
    return errors;
  }
  if (typeof value === "string") validateStringSchema(schema, value, path, errors);
  if (typeof value === "number") validateNumberSchema(schema, value, path, errors);
  if (Array.isArray(value)) validateArraySchema(schema, value, path, depth, errors);
  if (isRecord(value)) validateObjectSchema(schema, value, path, depth, errors);
  validateComposedSchema(schema, value, path, depth, errors);
  return errors;
}

function validateStringSchema(schema: JsonObject, value: string, path: string, errors: string[]): void {
  if (Number.isSafeInteger(schema.minLength) && value.length < Number(schema.minLength)) {
    errors.push(`${path}: length must be at least ${schema.minLength}`);
  }
  if (Number.isSafeInteger(schema.maxLength) && value.length > Number(schema.maxLength)) {
    errors.push(`${path}: length must be at most ${schema.maxLength}`);
  }
  if (typeof schema.pattern === "string") {
    try {
      if (!new RegExp(schema.pattern).test(value)) errors.push(`${path}: must match pattern`);
    } catch {
      errors.push(`${path}: schema pattern is invalid`);
    }
  }
}

function validateNumberSchema(schema: JsonObject, value: number, path: string, errors: string[]): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
  if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
}

function validateArraySchema(
  schema: JsonObject,
  value: unknown[],
  path: string,
  depth: number,
  errors: string[]
): void {
  if (Number.isSafeInteger(schema.minItems) && value.length < Number(schema.minItems)) {
    errors.push(`${path}: must contain at least ${schema.minItems} items`);
  }
  if (Number.isSafeInteger(schema.maxItems) && value.length > Number(schema.maxItems)) {
    errors.push(`${path}: must contain at most ${schema.maxItems} items`);
  }
  if (schema.items === undefined) return;
  if (!isRecord(schema.items) && typeof schema.items !== "boolean") {
    errors.push(`${path}: schema items must be an object or boolean`);
    return;
  }
  value.forEach((item, index) => errors.push(...jsonSchemaErrors(schema.items as JsonObject | boolean, item, `${path}[${index}]`, depth + 1)));
}

function validateObjectSchema(
  schema: JsonObject,
  value: JsonObject,
  path: string,
  depth: number,
  errors: string[]
): void {
  const required = stringList(schema.required);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${path}.${key}: is required`);
  }
  const properties = recordValue(schema.properties);
  for (const [key, child] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!isRecord(child) && typeof child !== "boolean") {
      errors.push(`${path}.${key}: property schema must be an object or boolean`);
      continue;
    }
    errors.push(...jsonSchemaErrors(child as JsonObject | boolean, value[key], `${path}.${key}`, depth + 1));
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`${path}.${key}: additional property is not allowed`);
    }
  } else if (isRecord(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(...jsonSchemaErrors(schema.additionalProperties, value[key], `${path}.${key}`, depth + 1));
      }
    }
  }
}

function validateComposedSchema(
  schema: JsonObject,
  value: unknown,
  path: string,
  depth: number,
  errors: string[]
): void {
  for (const [keyword, mode] of [["allOf", "all"], ["anyOf", "any"], ["oneOf", "one"]] as const) {
    const branches = arrayValue(schema[keyword]).filter((item) => isRecord(item) || typeof item === "boolean") as Array<JsonObject | boolean>;
    if (branches.length === 0) continue;
    const results = branches.map((branch) => jsonSchemaErrors(branch, value, path, depth + 1));
    if (mode === "all") results.forEach((result) => errors.push(...result));
    if (mode === "any" && results.every((result) => result.length > 0)) errors.push(`${path}: must match at least one ${keyword} branch`);
    if (mode === "one" && results.filter((result) => result.length === 0).length !== 1) errors.push(`${path}: must match exactly one oneOf branch`);
  }
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  return false;
}

function schemaShapeErrors(schema: JsonObject, path: string): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) errors.push(`${path}: unsupported schema keyword ${key}`);
  }
  if (schema.type !== undefined && typeof schema.type !== "string" && !Array.isArray(schema.type)) {
    errors.push(`${path}: schema type must be a string or string array`);
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) errors.push(`${path}: schema enum must be an array`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    errors.push(`${path}: schema required must be a string array`);
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) errors.push(`${path}: schema properties must be an object`);
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean" && !isRecord(schema.additionalProperties)) {
    errors.push(`${path}: schema additionalProperties must be an object or boolean`);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    if (schema[keyword] !== undefined && !Array.isArray(schema[keyword])) errors.push(`${path}: schema ${keyword} must be an array`);
  }
  return errors;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function validateEvidenceBinding(skill: SkillMetadata, input: Readonly<JsonObject>, output: unknown): void {
  if (skill.kind !== "domain") return;
  const allowed = new Set(inputEvidenceRefs(input));
  const actions = arrayValue(recordValue(output).action_proposals);
  for (const [index, action] of actions.entries()) {
    const refs = stringList(recordValue(action).evidence_refs);
    if (refs.length === 0) throw new SkillRuntimeError("evidence_missing", `action_proposals[${index}] has no evidence refs`);
    const foreign = refs.find((ref) => !allowed.has(ref));
    if (foreign) throw new SkillRuntimeError("evidence_out_of_scope", `action_proposals[${index}] references uncontrolled evidence: ${foreign}`);
  }
}

async function withTimeout(
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

function recordRunEvent(
  db: RunnerDatabase,
  audit: ToolCallAuditContext,
  runID: string,
  eventType: string,
  status: string,
  payload: JsonObject,
  error = ""
): void {
  createPiActionEvent(db, {
    action_id: runID,
    actor: "skill_runtime",
    conversation_id: audit.conversationID,
    decision: status,
    error,
    event_type: eventType,
    issue_id: audit.issueID ?? 0,
    payload_json: JSON.stringify({ ...payload, status }),
    project_id: audit.projectID,
    reason: `skill runtime ${status}`
  });
}

function auditContext(input: ExecuteSkillRuntimeInput): ToolCallAuditContext {
  return {
    conversationID: cleanString(input.auditContext?.conversationID),
    delegationID: cleanString(input.auditContext?.delegationID),
    heartbeatID: cleanString(input.auditContext?.heartbeatID),
    issueID: input.auditContext?.issueID,
    projectID: cleanString(input.auditContext?.projectID),
    source: cleanString(input.auditContext?.source) || "skill_runtime"
  };
}

function normalizeFailure(error: unknown): { code: string; message: string; status: "failed" | "timeout" } {
  const code = error instanceof SkillRuntimeError ? error.code : "handler_failed";
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    status: code === "skill_timeout" ? "timeout" : "failed"
  };
}

function effectiveMaxPermission(skill: SkillMetadata, workflow: SkillRuntimeWorkflowContext | undefined): ToolPermission {
  const skillMax = skillMaxPermission(skill);
  if (!workflow) return skillMax;
  return permissionRank(workflow.stage.permissions.max_tool_permission) < permissionRank(skillMax)
    ? workflow.stage.permissions.max_tool_permission
    : skillMax;
}

function skillMaxPermission(skill: SkillMetadata): ToolPermission {
  const value = skill.permissions?.max_tool_permission;
  return typeof value === "string" && TOOL_PERMISSIONS.includes(value as ToolPermission)
    ? value as ToolPermission
    : "read";
}

function permissionRank(permission: ToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}

function inputEvidenceRefs(input: Readonly<JsonObject>): string[] {
  const item = recordValue(input.inbox_item);
  if (Object.keys(item).length > 0) return stringList(item.evidence_refs);
  const bundle = recordValue(input.context_bundle);
  return stringList(bundle.evidence_refs);
}

function actionCount(output: unknown): number {
  return arrayValue(recordValue(output).action_proposals).length;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function recordValue(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values.map(cleanString).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function safeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function positiveInteger(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
