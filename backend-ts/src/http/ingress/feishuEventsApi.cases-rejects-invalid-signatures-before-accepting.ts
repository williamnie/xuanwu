import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase } from "../../db/database.ts";
import { createRequestHandler, createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./feishuEventsApi.testFixture.ts";

export function registerRejectsInvalidSignaturesBeforeAcceptingCases(testScope: TestFixture) {
  const { trackDatabase, ENCRYPT_KEY, tempRoots, fixtureHandler, postFeishu, messageEvent } = testScope;
  test("rejects invalid signatures before accepting encrypted-policy events", async () => {
      const { bus, database, handle } = await fixtureHandler({ encryptKey: ENCRYPT_KEY });
      const subscription = bus.subscribe();
      try {
        const response = await postFeishu(handle, messageEvent({ token: "verify-token" }), new Headers({
          "x-lark-request-nonce": "nonce-1",
          "x-lark-request-timestamp": String(Math.floor(Date.now() / 1000)),
          "x-lark-signature": "bad-signature"
        }));
        await subscription.next();
        const rejected = await subscription.next();
        const text = JSON.stringify({ audit: rejected, body: await response.json() });
  
        expect(response.status).toBe(401);
        expect(JSON.parse(String(rejected?.payload))).toMatchObject({
          outcome: "rejected",
          reason: "invalid_signature"
        });
        expect(text).not.toContain(ENCRYPT_KEY);
        expect(text).not.toContain("verify-token");
      } finally {
        subscription.close();
        database.close();
      }
    });
  
  test("returns a diagnostic error when connector config is incomplete", async () => {
      const root = await mkdtemp(join(tmpdir(), "xuanwu-feishu-http-"));
      tempRoots.push(root);
      const database = await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
      const config = buildConfig({ feishuAppId: "cli_app_id" });
      const router = createDefaultRouter({ config, database });
      const response = await postFeishu(createRequestHandler(router, ""), {
        challenge: "challenge-code",
        token: "verify-token",
        type: "url_verification"
      });
  
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ message: "feishu connector is not configured" });
    });
}
