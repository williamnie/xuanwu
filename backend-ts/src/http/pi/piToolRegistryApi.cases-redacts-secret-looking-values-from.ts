import { expect, test } from "bun:test";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piToolRegistryApi.testFixture.ts";

export function registerRedactsSecretLookingValuesFromCases(testScope: TestFixture) {
  const { BASE_URL, openFixture, seedSecretFixture } = testScope;
  test("redacts secret-looking values from stored registry metadata", async () => {
      const db = await openFixture();
      try {
        seedSecretFixture(db);
        const router = createDefaultRouter({ database: db });
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-http%3Asecret_probe`));
  
        expect(response.status).toBe(200);
        const text = JSON.stringify(await response.json());
        expect(text).toContain("[redacted]");
        expect(text).not.toContain("super-secret");
        expect(text).not.toContain("XUANWU_AUTH_TOKEN=abc");
      } finally {
        db.close();
      }
    });
}
