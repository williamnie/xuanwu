import type { PiGatePolicy } from "../pi/actionGate.ts";
import type { PiConversation } from "../db/repositories/pi.ts";

export function isReviewConversationIntent(value: string): boolean {
  return value.trim() === "review";
}

export function reviewConversationAuthorization(): PiGatePolicy {
  return {
    allowedActions: ["memory.search", "memory.write_candidate"],
    forbiddenActions: [
      "issue.create", "issue.enqueue", "issue.schedule_enqueue",
      "issue.retry", "issue.state_repair", "needs_user.escalate",
      "session.steer", "agent.workflow_request", "agent.executor_assign"
    ],
    mode: "attended"
  };
}

export function reviewConversationSource(conversation: PiConversation): string | undefined {
  return conversation.id.startsWith("feishu-") ? "feishu_runner_review" : undefined;
}
