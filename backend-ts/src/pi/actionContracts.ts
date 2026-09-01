export type PiActionRiskContract = "safe" | "confirm" | "high";
export type PiActionTargetContract = "issue" | "issue_batch" | "project" | "run" | "session" | "work";
export type PiActionResolutionContract = "dispatch" | "inline_current_turn";
export type PiActionFreshnessContract = "required" | "domain" | "ttl_only";

export type PiActionContract = {
  action_type: string;
  freshness: PiActionFreshnessContract;
  resolution: PiActionResolutionContract;
  risk: PiActionRiskContract;
  runner_chat_authorization: "exact_target" | "none";
  target: PiActionTargetContract;
};

const CONTRACTS: PiActionContract[] = [
  contract("agent.workflow_request", "confirm", "issue", "ttl_only"),
  contract("human_review.respond", "confirm", "issue", "required"),
  contract("issue.acceptance_request", "confirm", "issue", "ttl_only"),
  contract("issue.cancel", "confirm", "issue_batch", "required"),
  contract("issue.create", "confirm", "project", "ttl_only"),
  contract("issue.delete", "high", "issue_batch", "required"),
  contract("issue.enqueue", "confirm", "issue", "required"),
  contract("issue.schedule_enqueue", "confirm", "issue", "ttl_only"),
  contract("issue.state_repair", "confirm", "issue", "domain"),
  contract("issue.status_update", "confirm", "issue_batch", "required"),
  contract("issue_completion_watch.cancel", "confirm", "project", "ttl_only"),
  contract("issue_completion_watch.create", "confirm", "issue_batch", "ttl_only"),
  contract("notification.preference.update", "confirm", "project", "ttl_only"),
  contract("project.create", "confirm", "project", "ttl_only", "inline_current_turn"),
  contract("runner.settings_update", "high", "project", "ttl_only"),
  contract("run.interrupt", "safe", "run", "required"),
  contract("run.resume", "confirm", "run", "required"),
  contract("run.retry", "confirm", "run", "required"),
  contract("session.steer", "high", "session", "required", "dispatch", "none"),
  contract("system.restart", "high", "project", "ttl_only"),
  contract("work.cancel", "high", "work", "required"),
  contract("work.create", "confirm", "project", "ttl_only"),
  contract("work.enqueue", "confirm", "work", "required"),
  contract("work.retry", "confirm", "work", "required"),
  contract("work.update", "confirm", "work", "required"),
  contract("workspace.make_directory", "confirm", "project", "ttl_only", "inline_current_turn"),
  contract("workspace.write_file", "confirm", "project", "ttl_only", "inline_current_turn")
];

const BY_TYPE = new Map(CONTRACTS.map((item) => [item.action_type, item]));

export const PI_ACTION_CONTRACTS: readonly PiActionContract[] = Object.freeze(CONTRACTS.map(Object.freeze));

export function piActionContract(actionType: string): PiActionContract | undefined {
  return BY_TYPE.get(actionType);
}

export function runnerChatMutationActionTypes(): string[] {
  return CONTRACTS
    .filter((item) => item.runner_chat_authorization === "exact_target")
    .map((item) => item.action_type);
}

function contract(
  action_type: string,
  risk: PiActionRiskContract,
  target: PiActionTargetContract,
  freshness: PiActionFreshnessContract,
  resolution: PiActionResolutionContract = "dispatch",
  runner_chat_authorization: PiActionContract["runner_chat_authorization"] = "exact_target"
): PiActionContract {
  return { action_type, freshness, resolution, risk, runner_chat_authorization, target };
}
