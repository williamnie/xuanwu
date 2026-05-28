import { describe, expect, test } from "bun:test";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import { createRouter } from "./router.ts";

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Bun HTTP router", () => {
  test("dispatches requests by method and path", async () => {
    const router = createRouter();
    router.get("/health", () => json({ status: "ok" }));

    const response = await router.handle(new Request("http://127.0.0.1:3018/health"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await readJson(response)).toEqual({ status: "ok" });
  });

  test("returns stable JSON for not found paths", async () => {
    const router = createRouter();

    const response = await router.handle(new Request("http://127.0.0.1:3018/missing"));

    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({ message: "not found" });
  });

  test("returns method not allowed when a path exists for another method", async () => {
    const router = createRouter();
    router.get("/health", () => json({ status: "ok" }));

    const response = await router.handle(new Request("http://127.0.0.1:3018/health", {
      method: "POST"
    }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(await readJson(response)).toEqual({ message: "method not allowed" });
  });

  test("returns bad request JSON for malformed request bodies", async () => {
    const router = createRouter();
    router.post("/echo", async (request) => json(await parseJsonBody(request)));

    const response = await router.handle(new Request("http://127.0.0.1:3018/echo", {
      method: "POST",
      body: "{bad json",
      headers: { "content-type": "application/json" }
    }));

    expect(response.status).toBe(400);
    expect(await readJson(response)).toEqual({ message: "invalid json body" });
  });

  test("does not leak internal errors or stacks", async () => {
    const router = createRouter();
    router.get("/boom", () => {
      throw new Error("secret stack token");
    });

    const response = await router.handle(new Request("http://127.0.0.1:3018/boom"));
    const body = await readJson(response);

    expect(response.status).toBe(500);
    expect(body).toEqual({ message: "internal server error" });
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  test("preserves explicit safe HttpError messages", async () => {
    const router = createRouter();
    router.get("/teapot", () => {
      throw new HttpError(418, "short and stout");
    });

    const response = await router.handle(new Request("http://127.0.0.1:3018/teapot"));

    expect(response.status).toBe(418);
    expect(await readJson(response)).toEqual({ message: "short and stout" });
  });
});
