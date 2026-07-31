import type { RunnerDatabase } from "../db/database.ts";
import { getPiSupervisor } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { runProjectPiCycle } from "../http/piProjectControlApi.ts";
import { decideAgentCommunicationWithRuntime } from "../notifications/agentCommunicationGateway.ts";
import { runPiSupervisorDecision } from "../pi/issueSupervisorDecision.ts";
import { runPiIssueAcceptance } from "../pi/issueAcceptance.ts";
import type { CompletionCard } from "../domain/acceptance/completionCard.ts";
import type { AgenticProjectCycleResult, AgenticWorkerClient } from "./protocol.ts";
import { createAgenticActivityTracker } from "./activity.ts";

/** One-process compatibility adapter for `--role all`; split Core never imports this graph. */
export function createEmbeddedAgenticWorkerClient(db: RunnerDatabase): AgenticWorkerClient {
  const activity = createAgenticActivityTracker();
  return {
    activity: activity.snapshot,
    decideCommunication: (input) => activity.run(() => decideAgentCommunicationWithRuntime(db, input)),
    async decideIssueAcceptance(card: CompletionCard) {
      return activity.run(async () => {
        const agent = getPiSupervisor(db);
        if (!agent || agent.enabled !== 1) throw new Error("configured Supervisor is unavailable");
        const project = getProject(db, card.issue.project_id);
        if (!project) throw new Error(`Acceptance project is unavailable: ${card.issue.project_id}`);
        return runPiIssueAcceptance({ agent, card, database: db, project });
      });
    },
    async decideSupervisor(context) {
      return activity.run(async () => {
        const agent = getPiSupervisor(db);
        if (!agent || agent.enabled !== 1) throw new Error("configured Supervisor is unavailable");
        const projectID = typeof context.project.id === "string" ? context.project.id.trim() : "";
        if (projectID === "") throw new Error("Supervisor project id is unavailable");
        const project = getProject(db, projectID);
        if (!project) throw new Error(`Supervisor project is unavailable: ${projectID}`);
        return runPiSupervisorDecision({ agent, context, database: db, project });
      });
    },
    health: async () => ({ ok: true, role: "agentic" }),
    runProjectCycle: (input) => activity.run(
      () => runProjectPiCycle({ database: db }, input) as Promise<AgenticProjectCycleResult>
    )
  };
}
