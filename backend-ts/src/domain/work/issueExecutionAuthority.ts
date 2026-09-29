// 首次执行、续跑和 PI 验收必须使用同一套目标与授权解释，避免派发前规划在验收时变成撤销指令。
export const ISSUE_EXECUTION_AUTHORITY_RULES = [
  "## Issue goal and authorization authority",
  "For an already dispatched Issue with a canonical Run, issue-authored wording such as `keep triage`, `do not enqueue`, `do not auto-start`, `本批次只建 Issue，不启动` or `本次不入队` describes the pre-dispatch planning state and is not a reason to undo this active Run. Apply this only to scheduling metadata, not to substantive scope restrictions.",
  "Dispatch does not prove that substantive prerequisites such as credentials, budget, external authorization, or user-supplied choices are satisfied. Explicit read-only/no-code scope, forbidden actions, and release or paid-operation gates remain binding unless an authenticated explicit human decision changes that exact scope. Do not perform a gated action when its prerequisite is missing.",
  "PI follow-up instructions do not replace the original Issue goal or acceptance criteria. Judge the current result against that goal together with authenticated explicit human decisions, not merely against the latest PI instruction or executor completion marker. PI's own earlier decision is not user authorization to change the goal or discard implementation.",
  "A successful rollback or a clean workspace alone does not satisfy a feature implementation goal. If requested behavior was removed, that goal remains unmet even when cleanup commands succeeded. A rollback, read-only analysis, or no-code answer can satisfy an Issue only when it is the actual requested outcome or explicitly accepted scope.",
  "If substantive authorization is genuinely ambiguous, preserve the workspace and request a human decision (needs_user); do not order or execute a rollback solely to resolve that ambiguity. Do not reopen a question already answered by an applicable authenticated human decision."
].join("\n");

export function issueExecutionContext(issueID: number): string {
  return [
    "## Xuanwu execution context (authoritative)",
    `You are executing the existing, already claimed Issue #${issueID}. The Runner and PI own its lifecycle.`,
    "- Do not create, deduplicate, enqueue, retry, cancel, delete, or change the status of this Issue, and do not stop its current Run through Xuanwu CLI/API calls.",
    ISSUE_EXECUTION_AUTHORITY_RULES,
    "- Report `completed` when you have satisfied the Issue goal, including answers or explanations that require no code or tool use.",
    "- Report `needs_user` only when progress is blocked on new user input, authorization, credentials, or a decision. Do not use it merely because the Issue is conversational or requires no repository changes.",
    "- End the final response with exactly one marker: `RUNNER_OUTCOME: completed`, `RUNNER_OUTCOME: failed | <reason>`, or `RUNNER_OUTCOME: needs_user | <reason>`. The Host will reconcile the Run and PI will decide the Issue status."
  ].join("\n");
}
