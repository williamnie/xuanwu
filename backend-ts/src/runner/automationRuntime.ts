import type { RunnerDatabase } from "../db/database.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { recommendExecutorProfile } from "../pi/agentOrchestration.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { listSkillRegistry } from "../skills/registry.ts";
import { workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { implementWorkflowRegistryContributions } from "../workflows/implement.ts";
import { investigateWorkflowRegistryContributions } from "../workflows/investigate.ts";
import { repairWorkflowRegistryContributions, REPAIR_RECOVERY_ACTIONS } from "../workflows/repair.ts";
import { longRunningWorkflowRegistryContributions } from "../workflows/releaseResearchMigrate.ts";
import { reviewWorkflowRegistryContributions, REVIEW_WORKFLOW_ACTIONS } from "../workflows/review.ts";
import { createWorkflowRegistry, type WorkflowRegistry } from "../workflows/registry.ts";
import type { AutomationExecutor } from "./automationScheduler.ts";
import {
  createAutomationWorkRunExecutor,
  type AutomationWorkflowDispatcher
} from "./automationWorkRunExecutor.ts";
import { prepareStandingOrderExecution } from "./standingOrderRuntime.ts";
import { runIssueWithProvider } from "./providerRuntime.ts";

export type NativeAutomationRuntimeOptions = {
  bus?: Pick<EventBus, "publish">;
  database: RunnerDatabase;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

const BUILTIN_WORKFLOW_ACTIONS = [
  "handoff.commit",
  "migration.apply",
  "release.execute",
  "work.update",
  ...REPAIR_RECOVERY_ACTIONS,
  ...REVIEW_WORKFLOW_ACTIONS
] as const;

/** Production composition for the native Automation scheduler. */
export function createNativeAutomationExecutor(options: NativeAutomationRuntimeOptions): AutomationExecutor {
  return createAutomationWorkRunExecutor({
    dispatch: createNativeWorkflowDispatcher(options),
    prepare: prepareStandingOrderExecution,
    workflow_registry: createNativeWorkflowRegistry(options.database)
  });
}

export function createNativeWorkflowRegistry(database: RunnerDatabase): WorkflowRegistry {
  const contributions = [
    investigateWorkflowRegistryContributions(),
    implementWorkflowRegistryContributions(),
    repairWorkflowRegistryContributions(),
    reviewWorkflowRegistryContributions(),
    longRunningWorkflowRegistryContributions()
  ];
  const tools = loadAssistantToolRegistrySnapshot(database).tools;
  return createWorkflowRegistry({
    agent_profile_ids: listAgentProfiles(database).map((profile) => profile.id),
    available_actions: [...BUILTIN_WORKFLOW_ACTIONS],
    manifests: contributions.flatMap((item) => item.manifests),
    skills: listSkillRegistry({ availableTools: tools }),
    tools,
    verification_policies: contributions.flatMap((item) => item.verification_policies)
  });
}

export function createNativeWorkflowDispatcher(
  options: NativeAutomationRuntimeOptions
): AutomationWorkflowDispatcher {
  return async ({ automation, automation_run_id, context, work, workflow }) => {
    if (automation.mode === "observe") {
      return { detail: `observe mode recorded ${workflow.manifest_ref} without execution`, outcome: "skipped" };
    }
    if (automation.mode === "propose") {
      return { detail: `proposal materialized for ${workflow.manifest_ref}`, outcome: "succeeded" };
    }

    const issueID = workIDToIssueID(work.id);
    const issue = getIssue(options.database, issueID);
    const project = getProject(options.database, work.owner.kind === "project" ? work.owner.project_id : "");
    if (!issue || !project) throw new Error("automation workflow dispatch target is unavailable");
    const role = workflow.manifest.stages[0]?.agent.role ?? "executor";
    const selection = recommendExecutorProfile(options.database, project, { issue_id: issueID, role });
    const providerID = providerIDFor(selection.provider, project.provider);
    const provider = options.providers?.[providerID];
    if (!provider) throw new Error(`automation workflow provider \"${providerID}\" is not registered`);

    const result = await runIssueWithProvider(provider, {
      agentProfileId: selection.profile_id,
      agentRole: selection.agent_role,
      approvalPolicy: selection.approval_policy || project.approval_policy,
      bus: options.bus,
      capabilitySummary: provider.capabilities.join(","),
      cwd: project.cwd,
      database: options.database,
      issueId: issueID,
      model: selection.model || project.model,
      projectId: project.id,
      prompt: workflowPrompt(automation, automation_run_id, workflow, context),
      reasoningEffort: selection.reasoning_effort,
      sandbox: selection.sandbox || project.sandbox,
      selectionReason: `native Automation ${automation.id} resolved ${workflow.manifest_ref}`,
      serviceTier: selection.service_tier || project.default_service_tier,
      serviceTierSource: selection.service_tier ? "agent_profile" : "project"
    });
    return {
      detail: `workflow ${workflow.manifest_ref} dispatched as provider run ${result.runId}`,
      outcome: "succeeded"
    };
  };
}

function providerIDFor(selected: string, fallback: string): ExecutorProviderId {
  if (isExecutorProviderId(selected)) return selected;
  if (isExecutorProviderId(fallback)) return fallback;
  throw new Error(`automation workflow provider \"${selected || fallback}\" is not supported`);
}

function workflowPrompt(
  automation: Parameters<AutomationWorkflowDispatcher>[0]["automation"],
  automationRunID: string,
  workflow: Parameters<AutomationWorkflowDispatcher>[0]["workflow"],
  context?: Record<string, unknown>
): string {
  return [
    `Execute registered Workflow ${workflow.manifest_ref} for Automation run ${automationRunID}.`,
    `Automation mode: ${automation.mode}; permission policy: ${automation.permission_policy_ref}.`,
    "The linked Issue is the authoritative Work and its open issue_run is the authoritative Run.",
    "Follow every stage permission and approval declaration. Do not perform an external or destructive action without its deterministic approval gate.",
    "Do not create another Work/Run and do not write the linked Work terminal status; the Automation executor maps the provider result to Evidence and Handoff.",
    ...(context ? [
      `Deterministically selected Standing Order context: ${JSON.stringify(context)}`,
      "Treat this context as bounded operational input. Do not expand project scope, infer another commitment, or bypass the existing Action Proposal/Approval path."
    ] : []),
    `Workflow manifest snapshot: ${JSON.stringify(workflow.manifest)}`
  ].join("\n\n");
}
