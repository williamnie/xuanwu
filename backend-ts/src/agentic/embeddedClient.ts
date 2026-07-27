import type { RunnerDatabase } from "../db/database.ts";
import { getPiSupervisor } from "../db/repositories/pi.ts";
import { getProject } from "../db/repositories/projects.ts";
import { runProjectPiCycle } from "../http/piProjectControlApi.ts";
import { decideAgentCommunicationWithRuntime } from "../notifications/agentCommunicationGateway.ts";
import { runPiSupervisorDecision } from "../pi/issueSupervisorDecision.ts";
import type { AgenticProjectCycleResult, AgenticWorkerClient } from "./protocol.ts";
import { createAgenticActivityTracker } from "./activity.ts";

/** One-process compatibility adapter for `--role all`; split Core never imports this graph. */
export function createEmbeddedAgenticWorkerClient(db: RunnerDatabase): AgenticWorkerClient {
  const activity = createAgenticActivityTracker();
  return {
    activity: activity.snapshot,
    decideCommunication: (input) => activity.run(() => decideAgentCommunicationWithRuntime(db, input)),
    async decideSupervisor(context) {
      return activity.run(async () => {
        const agent = getPiSupervisor(db);
        if (!agent || agent.enabled !== 1) throw new Error("configured Supervisor is unavailable");
        const project = getProject(db, context.project.id);
        if (!project) throw new Error(`Supervisor project is unavailable: ${context.project.id}`);
        return runPiSupervisorDecision({ agent, context, database: db, project });
      });
    },
    health: async () => ({ ok: true, role: "agentic" }),
    runProjectCycle: (input) => activity.run(
      () => runProjectPiCycle({ database: db }, input) as Promise<AgenticProjectCycleResult>
    )
  };
}
