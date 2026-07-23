import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebGatewayConfig } from "../config/webGateway.ts";
import { createWebGatewayHandler } from "./webGateway.ts";

const roots: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  while (servers.length > 0) servers.pop()?.stop(true);
  while (roots.length > 0) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("Web Gateway", () => {
  test("serves SPA shell and hashed assets with distinct cache policies", async () => {
    const webDir = await webFixture();
    const handle = createWebGatewayHandler(config("http://127.0.0.1:1", webDir));

    const index = await handle(new Request("http://runner.local/deep/link"));
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-cache");
    expect(await index.text()).toContain("runner-shell");

    const asset = await handle(new Request("http://runner.local/assets/app-12345678.js"));
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await asset.text()).toBe("asset-ok");
  });

  test("preserves method, query, auth, error body, upload and download", async () => {
    const upstream = upstreamServer(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/error") {
        return new Response("validation failed", { status: 422, headers: { "content-type": "text/plain", "x-core-error": "yes" } });
      }
      if (url.pathname === "/api/upload") {
        const form = await request.formData();
        const file = form.get("file") as File;
        return Response.json({ name: file.name, size: file.size });
      }
      if (url.pathname === "/api/download") {
        return new Response(new Uint8Array([0, 1, 2, 255]), {
          headers: { "content-disposition": "attachment; filename=test.bin", "content-type": "application/octet-stream" }
        });
      }
      return Response.json({
        authorization: request.headers.get("authorization"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        method: request.method,
        query: url.searchParams.get("page"),
        value: await request.text()
      }, { status: 201, headers: { "x-core": "preserved" } });
    });
    const handle = createWebGatewayHandler(config(baseUrl(upstream)));

    const json = await handle(new Request("http://runner.local/api/json?page=7", {
      body: JSON.stringify({ ok: true }),
      headers: { authorization: "Bearer test-secret", "content-type": "application/json" },
      method: "POST"
    }));
    expect(json.status).toBe(201);
    expect(json.headers.get("x-core")).toBe("preserved");
    expect(await json.json()).toEqual({
      authorization: "Bearer test-secret",
      forwardedHost: "runner.local",
      method: "POST",
      query: "7",
      value: JSON.stringify({ ok: true })
    });

    const error = await handle(new Request("http://runner.local/api/error"));
    expect(error.status).toBe(422);
    expect(error.headers.get("x-core-error")).toBe("yes");
    expect(await error.text()).toBe("validation failed");

    const form = new FormData();
    form.set("file", new File(["upload-body"], "test.txt", { type: "text/plain" }));
    const upload = await handle(new Request("http://runner.local/api/upload", { body: form, method: "POST" }));
    expect(await upload.json()).toEqual({ name: "test.txt", size: 11 });

    const download = await handle(new Request("http://runner.local/api/download"));
    expect(download.headers.get("content-disposition")).toBe("attachment; filename=test.bin");
    expect([...new Uint8Array(await download.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });

  test("streams a POST SSE response beyond the bounded proxy timeout without buffering", async () => {
    const encoder = new TextEncoder();
    const upstream = upstreamServer((request) => new Response(new ReadableStream({
      async start(controller) {
        expect(request.method).toBe("POST");
        controller.enqueue(encoder.encode("event: accepted\ndata: {\"status\":\"accepted\"}\n\n"));
        await Bun.sleep(30);
        controller.enqueue(encoder.encode("event: completed\ndata: {\"status\":\"completed\"}\n\n"));
        controller.close();
      }
    }), { headers: { "content-type": "text/event-stream", "x-accel-buffering": "no" } }));
    const response = await createWebGatewayHandler(config(baseUrl(upstream), "", 10))(
      new Request("http://runner.local/api/pi/conversations/conv/messages", {
        body: JSON.stringify({ prompt: "slow turn" }),
        headers: { "content-type": "application/json" },
        method: "POST"
      })
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain("event: accepted");
    const second = await reader?.read();
    expect(new TextDecoder().decode(second?.value)).toContain("event: completed");
  });

  test("bounds unavailable/timeout failures and recovers without restarting Web", async () => {
    const reservation = upstreamServer(() => Response.json({ ok: true }));
    const port = reservation.port;
    reservation.stop(true);
    const handle = createWebGatewayHandler(config(`http://127.0.0.1:${port}`, "", 25));

    const unavailable = await handle(new Request("http://runner.local/api/projects"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");
    expect(await unavailable.json()).toMatchObject({ code: "core_unavailable" });

    const slow = Bun.serve({ port, fetch: async () => { await Bun.sleep(100); return Response.json({ ok: true }); } });
    servers.push(slow);
    const timeout = await handle(new Request("http://runner.local/api/projects"));
    expect(timeout.status).toBe(503);
    expect(await timeout.json()).toMatchObject({ code: "core_timeout" });
    slow.stop(true);
    servers.pop();

    const recovered = Bun.serve({ port, fetch: () => Response.json({ recovered: true }) });
    servers.push(recovered);
    const response = await handle(new Request("http://runner.local/api/projects"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recovered: true });
  });

  test("propagates client abort to the upstream request", async () => {
    let aborted = false;
    const upstream = upstreamServer((request) => new Promise<Response>((resolve) => {
      request.signal.addEventListener("abort", () => {
        aborted = true;
        resolve(new Response("aborted"));
      }, { once: true });
    }));
    const controller = new AbortController();
    const pending = createWebGatewayHandler(config(baseUrl(upstream)))(new Request("http://runner.local/api/wait", {
      signal: controller.signal
    }));
    await Bun.sleep(20);
    controller.abort();
    await expect(pending).rejects.toThrow();
    for (let index = 0; index < 20 && !aborted; index += 1) await Bun.sleep(5);
    expect(aborted).toBe(true);
  });
});

function upstreamServer(fetch: (request: Request) => Response | Promise<Response>): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `http://127.0.0.1:${server.port}`;
}

function config(coreAddr: string, webDir = "", proxyTimeoutMs = 1_000): WebGatewayConfig {
  return { addr: "127.0.0.1:3008", coreAddr, proxyTimeoutMs, webDir };
}

async function webFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runner-web-gateway-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<html>runner-shell</html>");
  await writeFile(join(root, "assets", "app-12345678.js"), "asset-ok");
  return root;
}
