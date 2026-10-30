import { describe } from "bun:test";
import { createTestFixture } from "./issuePatchApi.testFixture.ts";
import { registerPatchesIssueFieldsAndRecordsCases } from "./issuePatchApi.cases-patches-issue-fields-and-records.ts";
import { registerFailsClosedForRunHistoryCases } from "./issuePatchApi.cases-fails-closed-for-run-history.ts";

const fixture = createTestFixture();

describe("Bun issue patch API", () => {
  registerPatchesIssueFieldsAndRecordsCases(fixture);
  registerFailsClosedForRunHistoryCases(fixture);
});
