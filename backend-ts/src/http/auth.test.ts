import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { json } from "./errors.ts";
import { createRequestHandler } from "./server.ts";
import { createRouter, type Router } from "./router.ts";
import { loadAuthToken } from "./auth.ts";
import { redactSensitiveText } from "../util/redact.ts";

const BASE_URL = "http://127.0.0.1:3018";

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

async function tempTokenFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-runner-bun-auth-"));
  const path = join(dir, "auth_token");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return path;
}

function protectedRouter(): Router {
  const router = createRouter();
  router.get("/health", () => json({ status: "ok" }));
  router.get("/api/protected", () => json({ ok: true }));
  return router;
}

describe("Bun HTTP bearer auth", () => {
  test("protects API routes with Bearer token and leaves health public", async () => {
    const secret = "fixture-bearer-secret";
    const handle = createRequestHandler(protectedRouter(), secret);

    const health = await handle(new Request(`${BASE_URL}/health`));
    const missing = await handle(new Request(`${BASE_URL}/api/protected`));
    const wrong = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: "Bearer wrong-secret" }
    }));
    const allowed = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: `Bearer ${secret}` }
    }));

    expect(health.status).toBe(200);
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(allowed.status).toBe(200);
    expect(await readBody(allowed)).toBe(JSON.stringify({ ok: true }));

    const deniedBody = `${await readBody(missing)}\n${await readBody(wrong)}`;
    expect(deniedBody).not.toContain(secret);
    expect(deniedBody).not.toContain("auth_token");
  });

  test("leaves API routes open when auth token is not configured", async () => {
    const handle = createRequestHandler(protectedRouter(), "");

    const response = await handle(new Request(`${BASE_URL}/api/protected`));

    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe(JSON.stringify({ ok: true }));
  });

  test("loads auth token from env before token file", async () => {
    const file = await tempTokenFile("file-secret");

    const token = await loadAuthToken({ authToken: " env-secret ", authTokenFile: file });

    expect(token).toBe("env-secret");
  });

  test("loads auth token from file when env token is absent", async () => {
    const file = await tempTokenFile("file-secret");

    const token = await loadAuthToken({ authToken: "", authTokenFile: file });

    expect(token).toBe("file-secret");
  });

  test("returns no auth token when env and token file are unconfigured", async () => {
    const token = await loadAuthToken({ authToken: "", authTokenFile: "" });

    expect(token).toBe("");
  });

  test("sanitizes token file read errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-runner-bun-auth-"));
    const path = join(dir, "auth_token");
    await mkdir(path);

    try {
      await loadAuthToken({ authToken: "", authTokenFile: path });
      throw new Error("expected loadAuthToken to reject");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toBe("failed to read auth token file");
      expect(message).not.toContain(path);
      expect(message).not.toContain("auth_token");
    }
  });

  test("redacts bearer and auth token markers from diagnostic text", () => {
    const secret = "fixture-redaction-secret";
    const raw = [
      `Authorization: Bearer ${secret}`,
      `CODEX_RUNNER_BUN_AUTH_TOKEN=${secret}`,
      "generated file: /tmp/data-bun/auth_token"
    ].join("\n");

    const redacted = redactSensitiveText(raw);

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("Authorization:");
    expect(redacted).not.toContain("auth_token");
  });
});
