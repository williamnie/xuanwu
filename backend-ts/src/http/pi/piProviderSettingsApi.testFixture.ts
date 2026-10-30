import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import { createDefaultRouter } from "../server.ts";
import { useTestDatabase } from "../../testing/harness.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const openFixtureDatabase = useTestDatabase();

  const testServers: Array<ReturnType<typeof Bun.serve>> = [];

  function request(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
    return router.handle(new Request(`${BASE_URL}${path}`, {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    }));
  }

  function post(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
    return router.handle(new Request(`${BASE_URL}${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    }));
  }

  function deleteRequest(router: ReturnType<typeof createDefaultRouter>, path: string) {
    return router.handle(new Request(`${BASE_URL}${path}`, { method: "DELETE" }));
  }

  function modelsPath(database: RunnerDatabase): string {
    return join(dirname(database.path), "pi-runtime", "agent", "models.json");
  }

  function authPath(database: RunnerDatabase): string {
    return join(dirname(database.path), "pi-runtime", "agent", "auth.json");
  }

  async function writeSeedModels(database: RunnerDatabase, value: Record<string, unknown>): Promise<void> {
    const path = modelsPath(database);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function writeSeedAuth(database: RunnerDatabase, value: Record<string, unknown>): Promise<void> {
    const path = authPath(database);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  }
  return { BASE_URL, openFixtureDatabase, testServers, request, post, deleteRequest, modelsPath, authPath, writeSeedModels, writeSeedAuth };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
