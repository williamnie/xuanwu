import { parseMcpPolicy } from "../../mcp/policy.ts";
import { type PiConversation } from "../../db/repositories/pi.ts";
import { type Project } from "../../db/repositories/projects.ts";
import { PI_READ_ONLY_ACTION_TYPES } from "../../pi/actions/actionGate.ts";
import { reviewConversationAuthorization } from "./piConversationReview.ts";
import { cleanString } from "../../util/values.ts";

/** Action-gate authorization for Runner Chat and review conversations. */

export function conversationAuthorization(
  review: boolean,
  project: Project | undefined,
  runnerChatActions: readonly string[]
) {
  if (review) return reviewConversationAuthorization();
  if (project) return runnerChatAuthorization(project, runnerChatActions);
  return unboundRunnerChatAuthorization(runnerChatActions);
}

function runnerChatAuthorization(
  project: Project,
  runnerChatActions: readonly string[]
) {
  const actions = [...runnerChatActions];
  return {
    allowedActions: actions,
    allowedMcpCapabilities: parseMcpPolicy(project.default_mcp_policy).allowed,
    authorizedActions: runnerChatAuthorizedActions(actions),
    mode: "delegated" as const,
    scopes: [
      { runner_resource: "skills" },
      { runner_resource: "agent_catalog" },
      { runner_resource: "issues" },
      { runner_resource: "runner_settings" },
      { runner_resource: "service_lifecycle" },
      { project_id: project.id }
    ]
  };
}

function unboundRunnerChatAuthorization(runnerChatActions: readonly string[]) {
  const directlyAuthorizedActions = [
    ...PI_READ_ONLY_ACTION_TYPES,
    "project.create",
    "runner.settings_update",
    "system.restart",
    "workspace.make_directory",
    "workspace.write_file"
  ];
  return {
    allowedActions: [...runnerChatActions],
    askOnMissingAuthorization: true,
    authorizedActions: runnerChatAuthorizedActions(directlyAuthorizedActions),
    mode: "delegated" as const,
    scopes: [
      { runner_resource: "skills" },
      { runner_resource: "agent_catalog" },
      { runner_resource: "issues" },
      { runner_resource: "projects" },
      { runner_resource: "runner_settings" },
      { runner_resource: "service_lifecycle" },
      { runner_resource: "workspace" },
      { runner_resource: "optional_skills" }
    ]
  };
}

function runnerChatAuthorizedActions(actions: readonly string[]) {
  return actions.map((action_type) => ({ action_type }));
}

export function runnerChatSource(conversation: PiConversation): string | undefined {
  return conversation.id.startsWith("feishu-") ? "feishu_runner_chat" : "runner_chat";
}

export function imRunnerChatSource(connectorID: unknown): string | undefined {
  const connector = cleanString(connectorID).toLowerCase();
  return connector === "" ? undefined : `${connector}_runner_chat`;
}
