import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";
import { executeSafePiAction, type PiActionContext } from "./actionEngine.ts";
import { resolvePiNotificationPreference } from "./notificationPreferenceResolver.ts";
import { writePiNotificationPreference } from "./notificationPreferenceService.ts";
import { scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";

export const PI_NOTIFICATION_PREFERENCE_TOOL_NAMES = [
  "notification_preference_read",
  "notification_preference_update"
] as const;

export const PI_NOTIFICATION_PREFERENCE_ACTIONS = {
  read: "notification.preference.read",
  update: "notification.preference.update"
} as const;

type PreferenceToolName = typeof PI_NOTIFICATION_PREFERENCE_TOOL_NAMES[number];
type PreferenceContext = PiActionContext & { projectID?: string };
type PreferenceExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const scope = Type.Union([
  Type.Literal("run_group"),
  Type.Literal("conversation"),
  Type.Literal("project"),
  Type.Literal("global")
]);

const readParams = Type.Object({
  conversation_id: optionalString,
  project_id: optionalString,
  reference_time: optionalString,
  run_group_id: optionalString
}, objectOptions);

const updateParams = Type.Object({
  conversation_id: optionalString,
  digest_policy: Type.Optional(Type.Record(Type.String(), Type.Any())),
  expires_at: optionalString,
  mode: Type.Union([
    Type.Literal("quiet"),
    Type.Literal("digest"),
    Type.Literal("normal"),
    Type.Literal("verbose")
  ]),
  notify_on: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  project_id: optionalString,
  run_group_id: optionalString,
  scope,
  temporary: Type.Optional(Type.Boolean()),
  ttl_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10_080 }))
}, objectOptions);

export function createPiNotificationPreferenceTools(
  db: RunnerDatabase,
  context: PreferenceContext = {}
): ToolDefinition[] {
  return [
    preferenceTool(
      "notification_preference_read",
      "Notification Preference Read",
      "Read the effective notification preference for an explicit conversation/project/run-group context.",
      readParams,
      (params) => executeSafePiAction(db, context, {
        actionType: PI_NOTIFICATION_PREFERENCE_ACTIONS.read,
        payload: params,
        projectID: projectID(params.project_id, context),
        execute: () => resolvePiNotificationPreference(db, {
          conversationID: clean(params.conversation_id) || clean(context.conversationID),
          projectID: projectID(params.project_id, context),
          referenceTime: clean(params.reference_time),
          runGroupID: clean(params.run_group_id)
        })
      })
    ),
    preferenceTool(
      "notification_preference_update",
      "Notification Preference Update",
      "Persist PI's explicit structured notification preference choice. Natural-language parsing is PI's responsibility; this tool validates only schema, scope, and expiry.",
      updateParams,
      (params) => {
        const targetProjectID = projectID(params.project_id, context);
        const actionContext = scopedRunnerChatActionContext(
          context,
          PI_NOTIFICATION_PREFERENCE_ACTIONS.update,
          { projectID: targetProjectID }
        );
        return executeSafePiAction(db, actionContext, {
          actionType: PI_NOTIFICATION_PREFERENCE_ACTIONS.update,
          payload: params,
          projectID: targetProjectID,
          execute: () => writePiNotificationPreference(db, {
            ...params,
            conversation_id: clean(params.conversation_id) || clean(context.conversationID),
            policy_kind: "user_preference",
            project_id: targetProjectID,
            run_group_id: clean(params.run_group_id)
          })
        });
      }
    )
  ];
}

function preferenceTool<TParams extends TSchema>(
  name: PreferenceToolName,
  label: string,
  description: string,
  parameters: TParams,
  executePreference: PreferenceExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    description,
    label,
    name,
    parameters,
    async execute(_toolCallID, params) {
      const details = await executePreference(params);
      return toolResult(details);
    }
  };
}

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{
      text: formatModelVisibleToolOutput(details, { source: "tool_output" }),
      type: "text"
    }],
    details
  };
}

function projectID(value: unknown, context: PreferenceContext): string {
  return clean(value) || clean(context.projectID);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
