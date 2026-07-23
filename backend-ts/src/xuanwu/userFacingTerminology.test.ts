import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPERVISOR_NOTIFICATION_PREFIX, XUANWU_USER_FACING_TERMS } from "./userFacingTerminology.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const USER_VISIBLE_SOURCES = [
  "backend-ts/src/domain/work/timeline.ts",
  "backend-ts/src/http/piProjectControlApi.ts",
  "backend-ts/src/http/piRuntimeResources.ts",
  "backend-ts/src/http/piSupervisorActionDispatch.ts",
  "backend-ts/src/integrations/feishuAgentBridge.ts",
  "backend-ts/src/integrations/feishuGuardianAlerts.ts",
  "backend-ts/src/integrations/feishuMemoryCommands.ts",
  "backend-ts/src/integrations/feishuNotificationFormatters.ts",
  "backend-ts/src/integrations/feishuPiActionCards.ts",
  "backend-ts/src/notifications/piNeedsUserAction.ts",
  "backend-ts/src/notifications/piNotifier.ts",
  "backend-ts/src/pi/agentOrchestrationPayloads.ts",
  "backend-ts/src/pi/builtinToolRegistry.ts",
  "backend-ts/src/pi/digestFormatter.ts",
  "backend-ts/src/pi/guardianMissedDigestFallback.ts",
  "backend-ts/src/pi/guardianWatchdog.ts",
  "backend-ts/src/pi/intakeSkillInput.ts",
  "backend-ts/src/pi/issueProposalContext.ts",
  "backend-ts/src/pi/issueSupervisorDecision.ts",
  "backend-ts/src/pi/llmIntake.ts",
  "backend-ts/src/pi/mcpToolDefinitions.ts",
  "backend-ts/src/pi/memoryContext.ts",
  "backend-ts/src/pi/memoryTools.ts",
  "backend-ts/src/pi/nonIssueProposalActions.ts",
  "backend-ts/src/pi/recoveryActionPlanner.ts",
  "backend-ts/src/pi/repoContextPack.ts",
  "backend-ts/src/pi/runnerActionTools.ts",
  "backend-ts/src/pi/supervisorCommitments.ts",
  "backend-ts/src/runner/automationWorkRunExecutor.ts",
  "backend-ts/src/runner/watchAutomationRuntime.ts"
];
const CURRENT_PRODUCT_DOCS = [
  "README.md",
  "frontend/README.md",
  "docs/backup-restore.md",
  "docs/benchmarks/xuanwu-capacity-baseline.md",
  "docs/codex-integration.md",
  "docs/feishu-im-connector-contract.md",
  "docs/feishu-im-local-smoke.md",
  "docs/pi-repo-context-pack.md",
  "docs/runbooks/release-upgrade-rollback.md",
  "scripts/install-release.sh"
];
const FORBIDDEN_IDENTITIES = [
  "Pi：",
  "PI Assistant",
  "PI Guardian",
  "PI Supervisor",
  "PI Issue Supervisor",
  "PI 判断",
  "PI manager",
  "PI prompt",
  "PI repo_context_pack",
  "PI supervisor",
  "Runner Brain"
];

describe("Xuanwu user-facing terminology", () => {
  test("centralizes stable product and role labels for future locale catalogs", () => {
    expect(XUANWU_USER_FACING_TERMS).toEqual({
      guardian: "Guardian",
      product: "玄武",
      productLatin: "Xuanwu",
      runner: "Runner",
      supervisor: "Xuanwu Supervisor",
      supervisorShort: "Supervisor"
    });
    expect(SUPERVISOR_NOTIFICATION_PREFIX).toBe("玄武 Supervisor");
  });

  test("keeps legacy product identities out of live UI, notifications, prompts, and current docs", () => {
    const violations = [...USER_VISIBLE_SOURCES, ...CURRENT_PRODUCT_DOCS].flatMap((path) => {
      const text = source(path);
      return FORBIDDEN_IDENTITIES.filter((term) => text.includes(term)).map((term) => `${path}: ${term}`);
    });
    expect(violations).toEqual([]);
  });

  test("keeps canonical DB, singleton Supervisor API, CLI, runtime ID, and input alias identifiers", () => {
    expect(source("backend-ts/src/db/defaultPiAgent.ts")).toContain('DEFAULT_PI_AGENT_ID = "runner-default"');
    expect(source("backend-ts/src/http/piApi.ts")).toContain('router.get("/api/pi/supervisor"');
    expect(source("backend-ts/src/db/schema/003_pi_runtime.ts")).toContain("create table if not exists pi_agents");
    expect(source("backend-ts/src/db/schema/003_pi_runtime.ts")).toContain("pi_agent_id text not null");
    expect(source("backend-ts/src/providers/codex/adapter.ts")).toContain('name: "codex-issue-runner"');
    expect(source("backend-ts/src/pi/attentionRouter.ts")).toContain('|| "@PI"');
  });
});

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}
