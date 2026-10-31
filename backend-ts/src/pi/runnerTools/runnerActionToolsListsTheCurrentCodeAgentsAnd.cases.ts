import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { listAutomations } from "../../db/repositories/automations.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

import { HUMAN_REVIEW, HUMAN_REVIEW_RESPONSE, BATCH, VALID_ARGUMENTS, INVALID_ARGUMENTS, DELEGATED_CALLS, openDatabase, projectIDs, sessionKeys, fakeActions, detailedBatchItem, insertAgentProfile, openFixture, insertIssue, insertAgentSession } from "./runnerActionToolsFixtureHUMAN_REVIEW.ts";
import { toolByName, validateArgs, collectToolText, runTool } from "./runnerActionToolsFixtureToolByName.ts";

export function registerListsTheCurrentCodeAgentsAnd() {
test("lists the current Code Agents and durable Agent Profiles through one read-only tool", async () => {
    const fixture = await openFixture();
    insertAgentProfile(fixture.db, {
      id: "codex-general",
      name: "Codex General",
      skillIntents: "[\"xuanwu\"]"
    });
    const actions = createPiRunnerActions(fixture.db, {
      codeAgentCatalog: [{
        capabilities: { issueExecution: true },
        enabled: true,
        id: "codex",
        label: "Codex",
        legacy_capabilities: [],
        native_actions: [],
        session_actions: ["create", "resume"],
        settings: { settings: [] },
        state: "ready",
        submittable: true,
        supportLevel: "tested"
      }],
      project: fixture.project
    });

    const response = actions.listAgentCatalog({}) as {
      agent_profiles?: Array<Record<string, unknown>>;
      available_code_agent_ids?: string[];
      code_agents?: Array<Record<string, unknown>>;
      status: string;
    };

    expect(response).toMatchObject({
      agent_profiles: expect.arrayContaining([expect.objectContaining({
          id: "codex-general",
          provider: "codex",
          provider_available: true,
          skill_intents: ["xuanwu"]
        })]),
      available_code_agent_ids: ["codex"],
      code_agents: [expect.objectContaining({ id: "codex", state: "ready", submittable: true })],
      status: "completed"
    });
  });
}
