import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { parseSkillPolicy } from "../skills/intents.ts";

const TEMPLATE_TOKEN_RE = /\{\{([^{}]+)\}\}/g;

export function renderIssuePromptTemplate(
  template: string,
  input: { issue: Issue; project: Project }
): string {
  const values = issuePromptTemplateValues(input.project, input.issue);
  return String(template || "").replace(TEMPLATE_TOKEN_RE, (token, name) => (
    Object.hasOwn(values, name) ? values[name] : token
  ));
}

function issuePromptTemplateValues(project: Project, issue: Issue): Record<string, string> {
  const description = issue.description.trim();
  const title = issue.title.trim() || deriveIssueTitle(description);
  return {
    "project.id": project.id.trim(),
    "project.name": project.name.trim(),
    "project.cwd": project.cwd.trim(),
    "issue.id": String(issue.id),
    "issue.title": title,
    "issue.content": description || title,
    "issue.description": description,
    "issue.priority": String(issue.priority),
    "issue.required_skill_intents": issue.required_skill_intents,
    "issue.recommended_skill_intents": issue.recommended_skill_intents,
    "issue.required_mcp_capabilities": issue.required_mcp_capabilities,
    "issue.recommended_mcp_capabilities": issue.recommended_mcp_capabilities,
    "project.default_skill_policy": JSON.stringify(parseSkillPolicy(project.default_skill_policy)),
    "project.default_mcp_policy": JSON.stringify(parseMcpPolicy(project.default_mcp_policy))
  };
}

function deriveIssueTitle(description: string): string {
  return description.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
