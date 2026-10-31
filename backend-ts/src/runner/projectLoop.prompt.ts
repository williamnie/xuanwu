import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { githubWorkExecutionContext } from "../integrations/github/issueWorkflow.ts";
import { type Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { publicMcpRegistry } from "../mcp/registry.ts";
import { mergeSkillIntents, parseSkillPolicy } from "../skills/intents.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import { libraryRegistryOptions, managedSkillPolicy } from "../skills/libraryContext.ts";
import { currentSkillRevision, revisionPath, visibleManagedSkills } from "../skills/managedStore.ts";
import { dirname } from "node:path";
import { issueExecutionContext } from "../domain/work/issueExecutionAuthority.ts";
import { isRemoteProjectCwd } from "../nodes/projectLocation.ts";
import { NODE_SKILL_ROOT_TOKEN } from "../nodes/protocol.ts";

export function buildIssuePromptForTest(project: Project, issue: Issue, database?: RunnerDatabase): string {
  return buildIssuePrompt(project, issue, database);
}

export function buildIssuePrompt(project: Project, issue: Issue, database?: RunnerDatabase): string {
  const title = issue.title.trim();
  const description = issue.description.trim();
  const base = description === "" || description === title
    ? title
    : [`# ${title}`, "", description].join("\n");
  const humanDecisions = database && issue.source_session_id.startsWith("github:") ? githubWorkExecutionContext(database, issue.id) : "";
  return withRunnerContext(project, issue, [base, humanDecisions, "", issueExecutionContext(issue.id)].filter(Boolean).join("\n"), database);
}

export function withRunnerContext(project: Project, issue: Issue, prompt: string, database?: RunnerDatabase): string {
  return withMcpRequirementContext(
    project,
    issue,
    withSkillIntentContext(project, issue, withGovernedRetryContext(database, issue, prompt), database)
  );
}

export const SUPERVISOR_RETRY_EVENT = "issue.supervisor_retry";

export const MAX_RETRY_CONTEXT_CHARS = 4_000;

export function withGovernedRetryContext(database: RunnerDatabase | undefined, issue: Issue, prompt: string): string {
  const context = governedRetryContext(database, issue);
  if (!context) return prompt.trim();
  return [
    prompt.trim(),
    "",
    "## Governed retry context",
    "The Runner authorized this new attempt after Supervisor revalidation. The resolution below addresses the previous attempt's blocker. Apply it only within the original Issue goal and non-goals; it does not authorize unrelated expansion.",
    context.decisionID ? `Decision: ${context.decisionID}` : "",
    `Resolution: ${context.reason}`
  ].filter(Boolean).join("\n").trim();
}

export function governedRetryContext(
  database: RunnerDatabase | undefined,
  issue: Issue
): { decisionID: string; reason: string } | null {
  if (!database) return null;
  const event = listIssueEvents(database, issue.id, { limit: 1, types: [SUPERVISOR_RETRY_EVENT, "github.review_followup.v1"] })[0];
  if (!event) return null;
  try {
    const payload = JSON.parse(event.payload) as Record<string, unknown>;
    const reason = boundedPromptText(payload.reason, MAX_RETRY_CONTEXT_CHARS);
    if (reason === "") return null;
    return {
      decisionID: boundedPromptText(payload.decision_id, 512),
      reason
    };
  } catch {
    return null;
  }
}

export function boundedPromptText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

export function withSkillIntentContext(project: Project, issue: Issue, prompt: string, database?: RunnerDatabase): string {
  if (!hasSkillIntentContext(project, issue)) return prompt.trim();
  const policy = parseSkillPolicy(project.default_skill_policy);
  const metadata = matchedSkillMetadata(issue, policy, database, project);
  const skillContext = [
    "",
    "## Skill Intent Context",
    `Required skill intents: ${issue.required_skill_intents}`,
    `Recommended skill intents: ${issue.recommended_skill_intents}`,
    `Project default skill policy: ${JSON.stringify(policy)}`,
    metadata.length > 0 ? `Matched skills metadata: ${JSON.stringify(metadata)}` : ""
  ].filter((line) => line !== "").join("\n");
  return `${prompt.trim()}${skillContext}`.trim();
}

/** 远程项目引用的托管 Skill 版本：随运行下发到节点，节点按版本缓存。 */
export function remoteSkillPackages(project: Project, issue: Issue, database: RunnerDatabase): Array<{ directory: string; path: string }> {
  if (!hasSkillIntentContext(project, issue)) return [];
  return matchedManagedSkills(issue, parseSkillPolicy(project.default_skill_policy), database, project)
    .flatMap(({ installed }) => installed ? [{
      directory: currentSkillRevision(installed).directory,
      path: revisionPath(dirname(database.path), currentSkillRevision(installed))
    }] : []);
}

export function matchedSkillMetadata(issue: Issue, policy: ReturnType<typeof parseSkillPolicy>, database?: RunnerDatabase, project?: Project) {
  // 远程项目的 Skill 目录在节点上，以占位符引用，节点下发后替换成本机缓存路径。
  const remote = project ? isRemoteProjectCwd(project.cwd) : false;
  return matchedManagedSkills(issue, policy, database, project).map(({ installed, skill }) => ({
    ...skillSummary(skill),
    ...(installed && database ? {
      revision: installed.revision,
      base_directory: remote
        ? `${NODE_SKILL_ROOT_TOKEN}/${currentSkillRevision(installed).directory}`
        : revisionPath(dirname(database.path), currentSkillRevision(installed)),
      usage: "Read SKILL.md and its referenced resources. Keep this version immutable; write outputs and install dependencies in the task workspace."
    } : {})
  }));
}

export function matchedManagedSkills(issue: Issue, policy: ReturnType<typeof parseSkillPolicy>, database?: RunnerDatabase, project?: Project) {
  const requested = new Set(mergeSkillIntents(
    issue.required_skill_intents,
    issue.recommended_skill_intents,
    policy.required,
    policy.recommended
  ));
  if (requested.size === 0) return [];
  const managed = database ? visibleManagedSkills(dirname(database.path), project?.id) : [];
  const disabled = database ? managedSkillPolicy(database, project?.id).disabled : [];
  return listSkillRegistry(database ? libraryRegistryOptions(database, project) : {})
    .filter((skill) => requested.has(skill.id) || requested.has(skill.name))
    .filter(skill => !disabled.includes(skill.id))
    .map(skill => ({ installed: managed.find(item => item.id === skill.id), skill }));
}

export function hasSkillIntentContext(project: Project, issue: Issue): boolean {
  return issue.required_skill_intents !== "[]" || issue.recommended_skill_intents !== "[]" || project.default_skill_policy !== "{}";
}

export function withMcpRequirementContext(project: Project, issue: Issue, prompt: string): string {
  if (!hasMcpRequirementContext(project, issue)) return prompt.trim();
  const mcpContext = [
    "",
    "## MCP Requirement Context",
    `Required MCP capabilities: ${issue.required_mcp_capabilities}`,
    `Recommended MCP capabilities: ${issue.recommended_mcp_capabilities}`,
    `Project default MCP policy: ${JSON.stringify(parseMcpPolicy(project.default_mcp_policy))}`,
    `Available MCP registry: ${JSON.stringify(publicMcpRegistry().slice(0, 24))}`
  ].join("\n");
  return `${prompt.trim()}${mcpContext}`.trim();
}

export function hasMcpRequirementContext(project: Project, issue: Issue): boolean {
  return issue.required_mcp_capabilities !== "[]" || issue.recommended_mcp_capabilities !== "[]" || project.default_mcp_policy !== "{}";
}

export function skillSummary(skill: ReturnType<typeof listSkillRegistry>[number]) {
  return { id: skill.id, name: skill.name, description: skill.description, risk_level: skill.risk_level, allowed_roles: skill.allowed_roles };
}

export function optionalDate(value: Date | string | undefined): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
