import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { PI_MCP_TOOL_NAMES } from "../mcp/mcpToolDefinitions.ts";

export const PI_RUNNER_ACTION_TOOL_NAMES = [
  "agent_catalog_list",
  "agent_profile_recommend",
  "executor_profile_assign_proposal",
  "executor_issue_create_proposal",
  "review_workflow_request",
  "report_workflow_request",
  "needs_user_escalation",
  "human_review_request_create",
  "human_review_response",
  "issue_list",
  "issue_status_summary",
  "issue_execution_status",
  "issue_acceptance_request",
  "issue_read",
  "issue_create_proposal",
  "issue_create_batch_proposal",
  "issue_cancel",
  "issue_delete",
  "issue_status_update",
  "issue_state_diagnose",
  "issue_state_repair_proposal",
  "issue_comment",
  "issue_enqueue_batch_triage",
  "issue_enqueue_proposal",
  "issue_enqueue_next_triage",
  "issue_schedule_enqueue",
  "issue_completion_watch_create",
  "issue_completion_watch_list",
  "issue_completion_watch_cancel",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "manual_context_intake",
  "project_status",
  "project_list",
  "runner_settings_read",
  "runner_settings_update",
  "system_restart",
  "session_list",
  "session_read_summary",
  "session_steer_proposal",
  "skill_list",
  "skill_read",
  "skill_recommend",
  "skill_intent_audit",
  ...PI_MCP_TOOL_NAMES
] as const;

export type ActionToolName = (typeof PI_RUNNER_ACTION_TOOL_NAMES)[number];

export type ActionExecutor<TParams extends TSchema> = (params: Static<TParams>) => Promise<unknown> | unknown;

export const objectOptions = { additionalProperties: false };

export const optionalString = Type.Optional(Type.String());

export const requiredText = Type.String({ minLength: 1, pattern: "\\S" });

export const positiveID = Type.Integer({ minimum: 1 });

export const positiveNumber = Type.Integer({ minimum: 1 });

export const issueQueryScope = Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")]));

export const skillIntentList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));

export const mcpCapabilityList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));

export const textList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));

export const TOOL_RESULT_MAX_CHARS = 8192;

export const evidenceItem = Type.Object({
  confidence: optionalString,
  excerpt: optionalString,
  issue_id: Type.Optional(positiveID),
  message_id: optionalString,
  path: optionalString,
  reason: optionalString,
  session_key: optionalString,
  source_kind: optionalString,
  summary: optionalString
}, objectOptions);

export const evidenceValue = Type.Union([requiredText, evidenceItem]);

export const evidenceList = Type.Optional(Type.Array(evidenceValue));

export const relevantFile = Type.Object({
  path: requiredText,
  reason: optionalString,
  symbols: Type.Optional(Type.Array(requiredText))
}, objectOptions);

export const repoContextPack = Type.Optional(Type.Object({
  acceptance_criteria: textList,
  confidence: optionalString,
  evidence: evidenceList,
  intent: optionalString,
  open_questions: textList,
  project: Type.Optional(Type.Object({ cwd: optionalString, id: optionalString, name: optionalString }, objectOptions)),
  proposed_changes: textList,
  relevant_files: Type.Optional(Type.Array(relevantFile)),
  source: Type.Optional(Type.Object({
    channel: optionalString,
    kind: optionalString,
    message_id: optionalString,
    session_key: optionalString
  }, objectOptions)),
  validation: textList,
  "需求理解": optionalString,
  "相关证据": textList,
  "相关文件": Type.Optional(Type.Array(relevantFile)),
  "建议改动": textList,
  "验收标准": textList,
  "验证建议": textList,
  "未确认问题": textList
}, objectOptions));
