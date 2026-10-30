import { expect, test } from "bun:test";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piSkillsApi.testFixture.ts";

export function registerListsIntakeAndDomainRunsCases(testScope: TestFixture) {
  const { openFixture, writeManifestSkill, intakeManifest, domainManifest, seedSkillRunFixture, jsonRequest, textRequest } = testScope;
  test("lists intake and domain runs, manual runs, links, and redacted failures", async () => {
      const fixture = await openFixture();
      await writeManifestSkill(fixture.root, "fixture-intake", intakeManifest());
      await writeManifestSkill(fixture.root, "fixture-domain", domainManifest());
      Bun.env.CODEX_HOME = fixture.root;
      try {
        const seed = seedSkillRunFixture(fixture.db);
        const router = createDefaultRouter({ database: fixture.db });
  
        const intakeRun = await jsonRequest(router, "/api/pi/skills/fixture-intake/intake-runs", {
          body: JSON.stringify({ bundle_id: seed.bundleID }),
          method: "POST"
        });
        expect(intakeRun.run).toMatchObject({
          bundle_id: seed.bundleID,
          input_object: "context_bundle",
          lifecycle: { execution: "running" },
          links: { context_bundle: `/api/pi/attention-inbox/context-bundles/${seed.bundleID}` },
          skill_id: "fixture-intake",
          status: "running"
        });
  
        const domainRun = await jsonRequest(router, "/api/pi/skills/fixture-domain/domain-runs", {
          body: JSON.stringify({ item_id: seed.itemID }),
          method: "POST"
        });
        expect(domainRun.run).toMatchObject({
          bundle_id: seed.bundleID,
          input_object: "inbox_item",
          item_id: seed.itemID,
          lifecycle: { execution: "executed" },
          links: {
            context_bundle: `/api/pi/attention-inbox/context-bundles/${seed.bundleID}`,
            inbox_item: `/api/pi/attention-inbox/items/${seed.itemID}`
          },
          skill_id: "fixture-domain",
          status: "succeeded"
        });
  
        const intakeRunsText = await textRequest(router, "/api/pi/skills/intake-runs?status=failed");
        expect(intakeRunsText).toContain("run_failed");
        expect(intakeRunsText).not.toContain("fixture-secret");
        expect(intakeRunsText).not.toContain("/Users/secret");
        const intakeDetailText = await textRequest(router, `/api/pi/attention-inbox/intake-runs/${seed.failedRunID}`);
        expect(intakeDetailText).not.toContain("fixture-secret");
        expect(intakeDetailText).not.toContain("/Users/secret");
  
        const domainRuns = await jsonRequest(router, "/api/pi/skills/domain-runs?skill_id=fixture-domain");
        expect(domainRuns).toEqual([expect.objectContaining({
          proposal_action_id: domainRun.action.id,
          schema_output: expect.objectContaining({
            action_proposals: expect.any(Array),
            context_retrieval: expect.objectContaining({
              memory_items: [
                expect.objectContaining({ id: "skill-api-inbox-memory", source_path: "pi_memory_items/skill-api-inbox-memory" }),
                expect.objectContaining({ id: "skill-api-source-memory" })
              ],
              retrieval_scopes: ["inbox:1", "source:fixture-im", "skill:fixture-domain", "project:demo", "global:runner"],
              retrieval: expect.objectContaining({ scanned: 4 }),
              truncation_summary: expect.objectContaining({ total_candidates: 4, selected_count: 2, omitted_count: 2 })
            })
          })
        })]);
      } finally {
        fixture.db.close();
      }
    });
}
