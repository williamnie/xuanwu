import type { Issue } from "../../db/repositories/issues.ts";

/**
 * Give the executor both instruction sources and a stable precedence rule.
 * The Agent interprets semantic conflicts; deterministic code does not classify
 * commit/retry/review wording or manufacture a derived intent.
 */
export function withIssueInstructionPrecedence(
  prompt: string,
  issue: Pick<Issue, "description" | "prompt_template">
): string {
  if (issue.prompt_template.trim() === "" || issue.description.trim() === "") return prompt.trim();
  return [
    prompt.trim(),
    "",
    "## Instruction source precedence",
    "- Interpret the Issue-specific description and the generic prompt template using the full context.",
    "- If they conflict, the Issue-specific description wins. Do not use keyword matching or invent a compromise artifact.",
    "- Report any unresolved ambiguity instead of silently choosing a contradictory requirement."
  ].join("\n").trim();
}
