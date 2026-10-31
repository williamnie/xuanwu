import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

  async function createResolution(router: ReturnType<typeof createDefaultRouter>, id: string): Promise<Response> {
    return request(router, "/api/pi/memory", "POST", {
      id,
      memory_key: `resolution.${id}`,
      memory_type: "project",
      layer: "long_term",
      scope: "project",
      scope_id: "demo",
      kind: "resolution",
      content: "根因是 completion gate 未复验；修复方式是检查 Evidence 和 Handoff。",
      source_type: "manual",
      source_id: "settings-memory-form",
      citation_type: "handoff",
      citation_id: "issue-785",
      citation_label: "Issue #785 verified handoff",
      confidence: "high"
    });
  }

  function request(
    router: ReturnType<typeof createDefaultRouter>,
    path: string,
    method: string,
    body: Record<string, unknown>
  ) {
    return router.handle(new Request(`${BASE_URL}${path}`, {
      method,
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    }));
  }
  return { BASE_URL, openFixtureDatabase, createResolution, request };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
