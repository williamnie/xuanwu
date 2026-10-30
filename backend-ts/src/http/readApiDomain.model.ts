import { type IssueActionOptions } from "../db/repositories/issueActions.ts";
import { type Issue, type IssueRun } from "../db/repositories/issues.ts";
import { type McpRequirementSummary } from "../mcp/requirements.ts";
import { type IssueDependencyDiagnostic } from "../domain/work/issueDependency.ts";
import type { RunnerDatabase } from "../db/database.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import type { createReadApiDomainHandlers } from "./readApiDomain.createReadApiDomainHandlers.ts";

export type IssueListFilter = {
  projectId: string;
  sourceSessionId: string;
  status: string;
};

export type IssueMutationActor = {
  kind: "managed_executor" | "operator";
  source: string;
  threadID: string;
};

export type IssueAction = (db: RunnerDatabase, id: number, options?: IssueActionOptions) => unknown;

export type PublicIssueRun = Omit<IssueRun, "runtime_metadata_json">;

export type PublicIssueRunMetadata = Record<string, unknown>;

export type PublicIssueRunView = PublicIssueRun & {
  runtime_metadata: PublicIssueRunMetadata;
  service_tier: string;
  service_tier_source: string;
};

export type PublicIssue = Omit<Issue, "latest_run"> & {
  decision: ReturnType<typeof readIssueDecisionProjection>;
  dependency: IssueDependencyDiagnostic;
  latest_run?: PublicIssueRunView;
  mcp_requirements: McpRequirementSummary;
};

export type ReadApiDomainHandlers = ReturnType<typeof createReadApiDomainHandlers>;
