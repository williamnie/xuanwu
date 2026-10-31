import { type Issue } from "../db/repositories/issues.ts";
import { type CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { PiAcceptanceDecision } from "../pi/issues/issueAcceptance.ts";
import { issueExecutionContext } from "../domain/work/issueExecutionAuthority.ts";

export function continuationPrompt(
  issue: Issue,
  decision: PiAcceptanceDecision,
  humanReview: CompletionCard["human_review"]
): string {
  return [
    `继续处理 Issue #${issue.id}：${issue.title}`,
    "",
    "原始 Issue 目标、验收标准与限制（结合下方已认证人类决定解释）：",
    issue.description.trim() || issue.title,
    "",
    "这是 PI 对上一 Run 小结卡片的验收结论。必须在同一个 Provider Session 的新 Run/Turn 中继续，不得创建新的业务 Issue 或 Verifier Issue。",
    humanReviewContext(humanReview),
    `验收动作：${decision.decision}`,
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "修复上述问题并补充最小充分的真实验证。"}`,
    "",
    issueExecutionContext(issue.id),
    "先读取当前工作区，避免重复已经成功的步骤。完成后报告改动文件、命令和退出码。Runner Host 负责最终状态写回。",
    "已满足 Issue 目标时使用 completed，包括不需要代码或工具的回答与解释。只有确实缺少新的用户输入、授权、凭据或决策时才使用 needs_user；不要因为任务是对话或没有仓库改动而使用 needs_user。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

export function retryPrompt(issue: Issue, decision: PiAcceptanceDecision, humanReview: CompletionCard["human_review"]): string {
  return [
    `重新处理 Issue #${issue.id}：${issue.title}`,
    "",
    "原始 Issue 目标、验收标准与限制（结合下方已认证人类决定解释）：",
    issue.description.trim() || issue.title,
    "",
    "PI 已确认原 Provider Session 无法可靠继续，因此这是同一个 Issue 的新 Session。不要创建新的业务 Issue 或 Verifier Issue。",
    humanReviewContext(humanReview),
    `理由：${decision.rationale}`,
    decision.unmet_requirements.length > 0 ? `未满足项：${decision.unmet_requirements.join("；")}` : "",
    `具体后续：${decision.follow_up_prompt || "读取当前工作区，完成剩余工作并执行最小充分验证。"}`,
    "",
    issueExecutionContext(issue.id),
    "必须先读取当前工作区和已有改动，避免重复或覆盖已完成步骤。Runner Host 负责最终状态写回。",
    "已满足 Issue 目标时使用 completed，包括不需要代码或工具的回答与解释。只有确实缺少新的用户输入、授权、凭据或决策时才使用 needs_user；不要因为任务是对话或没有仓库改动而使用 needs_user。",
    "最终回复必须以 RUNNER_OUTCOME: completed、RUNNER_OUTCOME: failed | <reason> 或 RUNNER_OUTCOME: needs_user | <reason> 结尾。"
  ].filter(Boolean).join("\n");
}

export function humanReviewContext(review: CompletionCard["human_review"]): string {
  if (!review) return "";
  return [
    `已认证的人类回复类型：${review.request.kind}`,
    `原人类问题：${review.request.question}`,
    `已认证的人类回复动作：${review.action}`,
    review.comment ? `已认证的人类回复：${review.comment}` : ""
  ].filter(Boolean).join("\n");
}
