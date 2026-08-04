import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { json } from "./errors.ts";
import { createRequestHandler } from "./server.ts";
import { createRouter, type Router } from "./router.ts";
import { createAuthTokenManager, loadAuthToken } from "./auth.ts";
import { registerAuthTokenRoutes } from "./authTokenApi.ts";
import { redactSensitiveText } from "../util/redact.ts";

const BASE_URL = "http://127.0.0.1:3008";

async function readBody(response: Response): Promise<string> {
  return await response.text();
}

async function tempTokenFile(token: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xuanwu-bun-auth-"));
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


  test("allows local browser origins to read API routes", async () => {
    const secret = "fixture-bearer-secret";
    const handle = createRequestHandler(protectedRouter(), secret);
    const origin = "http://127.0.0.1:3568";

    const preflight = await handle(new Request(`${BASE_URL}/api/protected`, {
      method: "OPTIONS",
      headers: { origin }
    }));
    const allowed = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: `Bearer ${secret}`, origin }
    }));
    const denied = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: `Bearer ${secret}`, origin: "https://evil.example" }
    }));
    const proxiedSameOrigin = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: {
        authorization: `Bearer ${secret}`,
        host: "127.0.0.1:3009",
        origin: "https://runner.example",
        "x-forwarded-host": "runner.example",
        "x-forwarded-proto": "https"
      }
    }));
    const untrustedForwarder = await handle(new Request("http://runner.example/api/protected", {
      headers: {
        authorization: `Bearer ${secret}`,
        host: "runner.example",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https"
      }
    }));

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(origin);
    expect(denied.status).toBe(403);
    expect(proxiedSameOrigin.status).toBe(200);
    expect(untrustedForwarder.status).toBe(403);
  });

  test("accepts same-origin cookie auth for browser SSE compatibility", async () => {
    const secret = "fixture-cookie-secret";
    const handle = createRequestHandler(protectedRouter(), secret);

    const response = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { cookie: `xuanwu_token=${encodeURIComponent(secret)}` }
    }));

    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe(JSON.stringify({ ok: true }));
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

  test("atomically creates one mode-0600 token for concurrent service startup", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuanwu-bun-auth-create-"));
    const path = join(dir, "auth_token");

    const [first, second] = await Promise.all([
      createAuthTokenManager({ authToken: "", authTokenFile: path }),
      createAuthTokenManager({ authToken: "", authTokenFile: path })
    ]);

    expect(first.current()).toBe(second.current());
    expect(first.current()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readFile(path, "utf8")).trim()).toBe(first.current());
    expect(first.status()).toEqual({ configured: true, rotatable: true, source: "file" });
  });

  test("rotates a file-managed token once and invalidates the previous credential", async () => {
    const file = await tempTokenFile("old-file-secret");
    const manager = await createAuthTokenManager({ authToken: "", authTokenFile: file });
    const router = protectedRouter();
    registerAuthTokenRoutes(router, { manager });
    const handle = createRequestHandler(router, manager);

    const rotated = await handle(new Request(`${BASE_URL}/api/auth/token/rotate`, {
      body: JSON.stringify({ confirm: "rotate" }),
      headers: { authorization: "Bearer old-file-secret", "content-type": "application/json" },
      method: "POST"
    }));
    const body = await rotated.json() as { token: string };
    const oldCredential = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: "Bearer old-file-secret" }
    }));
    const newCredential = await handle(new Request(`${BASE_URL}/api/protected`, {
      headers: { authorization: `Bearer ${body.token}` }
    }));

    expect(rotated.status).toBe(200);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.token).not.toBe("old-file-secret");
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    expect(oldCredential.status).toBe(401);
    expect(newCredential.status).toBe(200);
    expect((await readFile(file, "utf8")).trim()).toBe(body.token);
  });

  test("reports environment-managed auth without exposing or rotating its value", async () => {
    const manager = await createAuthTokenManager({ authToken: "environment-secret", authTokenFile: "" });
    const router = protectedRouter();
    registerAuthTokenRoutes(router, { manager });
    const handle = createRequestHandler(router, manager);

    const status = await handle(new Request(`${BASE_URL}/api/auth/token`, {
      headers: { authorization: "Bearer environment-secret" }
    }));
    const rotate = await handle(new Request(`${BASE_URL}/api/auth/token/rotate`, {
      body: JSON.stringify({ confirm: "rotate" }),
      headers: { authorization: "Bearer environment-secret", "content-type": "application/json" },
      method: "POST"
    }));
    const statusText = await status.text();
    const rotateText = await rotate.text();

    expect(JSON.parse(statusText)).toEqual({ configured: true, rotatable: false, source: "environment" });
    expect(rotate.status).toBe(409);
    expect(`${rotateText} ${statusText}`).not.toContain("environment-secret");
  });

  test("returns no auth token when env and token file are unconfigured", async () => {
    const token = await loadAuthToken({ authToken: "", authTokenFile: "" });

    expect(token).toBe("");
  });

  test("sanitizes token file read errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "xuanwu-bun-auth-"));
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
      `XUANWU_AUTH_TOKEN=${secret}`,
      "generated file: /tmp/data-bun/auth_token"
    ].join("\n");

    const redacted = redactSensitiveText(raw);

    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("Authorization:");
    expect(redacted).not.toContain("auth_token");
  });
});
