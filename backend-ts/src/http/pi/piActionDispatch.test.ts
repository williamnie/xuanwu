import { describe } from "bun:test";
import { createTestFixture } from "./piActionDispatch.testFixture.ts";
import { registerIssueEnqueueStartsOnlyAutoCases } from "./piActionDispatch.cases-issue-enqueue-starts-only-auto.ts";
import { registerSessionResumeFollowupSendsACases } from "./piActionDispatch.cases-session-resume-followup-sends-a.ts";
import { registerIssueSupervisorDecisionRecordsPiCases } from "./piActionDispatch.cases-issue-supervisor-decision-records-pi.ts";
import { registerResumeFollowUpRevalidatesHarmlessCases } from "./piActionDispatch.cases-resume-follow-up-revalidates-harmless.ts";

const fixture = createTestFixture();

describe("PI action dispatcher supervisor actions", () => {
  registerIssueEnqueueStartsOnlyAutoCases(fixture);
  registerSessionResumeFollowupSendsACases(fixture);
  registerIssueSupervisorDecisionRecordsPiCases(fixture);
  registerResumeFollowUpRevalidatesHarmlessCases(fixture);
});
