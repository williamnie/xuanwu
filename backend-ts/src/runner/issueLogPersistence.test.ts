import { describe } from "bun:test";
import { registerIssueLogPersistenceReductionCases } from "./issueLogPersistenceReductionCases.ts";
import { registerIssueLogPersistenceArtifactsCases } from "./issueLogPersistenceArtifactsCases.ts";
import { registerIssueLogPersistenceContinuation2Cases } from "./issueLogPersistenceContinuation2Cases.ts";

describe("issue.log persistence reduction", () => {
  registerIssueLogPersistenceReductionCases();
  registerIssueLogPersistenceArtifactsCases();
  registerIssueLogPersistenceContinuation2Cases();
});
