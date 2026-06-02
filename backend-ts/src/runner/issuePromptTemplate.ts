import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";

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
    "issue.priority": String(issue.priority)
  };
}

function deriveIssueTitle(description: string): string {
  return description.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}
