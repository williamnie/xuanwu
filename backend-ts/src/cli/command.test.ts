import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./command.ts";

const tempRoots: string[] = [];

beforeEach(() => {
  tempRoots.length = 0;
});

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun CLI dispatcher", () => {
  test("gets system status as human summary", async () => {
    const fetcher = fetchStub((request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://127.0.0.1:3008/api/system/status");
      expect(request.headers.get("authorization")).toBeNull();
      return jsonResponse(systemStatusBody());
    });
    const { code, stdout, stderr } = await run(["system", "status"], { fetcher });

    expect(code).toBe(0);
    expect(stdout).toBe("API alive=true db=true codex_cmd=true auth=true loops=2 in_progress=1 connectors=feishu:disabled\n");
    expect(stderr).toBe("");
  });

  test("shows Codex capability summary when status provides it", async () => {
    const fetcher = fetchStub(() => jsonResponse({
      ...systemStatusBody(),
      codex: { command_ok: true, capability_summary: "issue_execution,sessions,model_list" }
    }));
    const { stdout } = await run(["system", "status"], { fetcher });

    expect(stdout).toBe(
      "API alive=true db=true codex_cmd=true auth=true loops=2 in_progress=1 codex_caps=issue_execution,sessions,model_list connectors=feishu:disabled\n"
    );
  });

  test("pretty prints JSON and sends token from env", async () => {
    const fetcher = fetchStub((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer env-token");
      return jsonResponse(systemStatusBody());
    });
    const { code, stdout } = await run(["system", "status", "--json"], {
      env: envMap({ XUANWU_AUTH_TOKEN: "env-token" }),
      fetcher
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ service: { alive: true } });
    expect(stdout).toContain("\n  \"service\": {");
  });

  test("token flag overrides token file and is not printed", async () => {
    const file = await tempTokenFile("file-token");
    const secret = "flag-secret";
    const fetcher = fetchStub((request) => {
      expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
      return jsonResponse(systemStatusBody());
    });
    const { code, stdout, stderr } = await run([
      "system", "status", "--token-file", file, "--token", secret
    ], { fetcher });

    expect(code).toBe(0);
    expect(stdout).not.toContain(secret);
    expect(stderr).not.toContain(secret);
  });

  test("reads token from token file env", async () => {
    const file = await tempTokenFile("file-token");
    const fetcher = fetchStub((request) => {
      expect(request.url).toBe("http://127.0.0.1:3008/api/system/doctor");
      expect(request.headers.get("authorization")).toBe("Bearer file-token");
      return jsonResponse(systemStatusBody());
    });
    const { code } = await run(["doctor"], {
      env: envMap({ XUANWU_AUTH_TOKEN_FILE: file }),
      fetcher
    });

    expect(code).toBe(0);
  });

  test("doctor prints deterministic first-use fixes without changing the JSON contract", async () => {
    const body = {
      auth: { enabled: true },
      db: { ok: true },
      health: { reasons: [{ code: "provider_unavailable", message: "Codex is unavailable", source: "provider:codex" }], state: "degraded" },
      providers: [{ available: false, id: "codex", label: "Codex", status: "missing" }],
      security: { warnings: [] },
      service: { alive: true }
    };
    const fetcher = fetchStub(() => jsonResponse(body));

    const human = await run(["doctor"], { fetcher });
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Doctor health=degraded api=true db=true providers=codex:missing");
    expect(human.stdout).toContain("fix: install and sign in to an executor CLI");
    expect(human.stdout).toContain("codex --version");

    const json = await run(["doctor", "--json"], { fetcher });
    expect(JSON.parse(json.stdout)).toEqual(body);
  });

  test("creates project against live default addr", async () => {
    const fetcher = fetchStub(async (request) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://127.0.0.1:3008/api/projects");
      const body = await request.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        id: "demo",
        cwd: "/tmp/demo"
      });
      expect(body).not.toHaveProperty("auto_run");
      return jsonResponse({ id: "demo", cwd: "/tmp/demo", auto_run: 1, pi_managed: 1, loop_status: "stopped" }, 201);
    });
    const { code, stdout, stderr } = await run([
      "project", "create", "--id", "demo", "--cwd", "/tmp/demo"
    ], { fetcher });

    expect(code).toBe(0);
    expect(stdout).toBe("demo [managed] /tmp/demo\n");
    expect(stderr).toBe("");
  });

  test("creates project as JSON and redacts token on API errors", async () => {
    const secret = "project-secret";
    const okFetcher = fetchStub(() => jsonResponse({ id: "demo", cwd: "/tmp/demo" }, 201));
    const ok = await run([
      "project", "create", "--id", "demo", "--cwd", "/tmp/demo", "--json"
    ], { fetcher: okFetcher });

    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ id: "demo", cwd: "/tmp/demo" });

    const failFetcher = fetchStub(() => jsonResponse({ message: `bad token ${secret}` }, 400));
    const failed = await run([
      "project", "create", "--id", "demo", "--cwd", "/tmp/demo", "--token", secret
    ], { fetcher: failFetcher });

    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("[redacted]");
    expect(failed.stderr).not.toContain(secret);
  });

  test("gets system logs with line limit", async () => {
    const fetcher = fetchStub((request) => {
      expect(request.method).toBe("GET");
      expect(request.url).toBe("http://127.0.0.1:3008/api/system/logs?lines=2");
      return jsonResponse({
        logs: [{
          available: true,
          lines: [{ level: "info", source: "server", text: "started token=hidden", time: "2026-05-28T00:00:00Z" }],
          source: "server"
        }]
      });
    });
    const { code, stdout } = await run(["system", "logs", "--lines", "2"], { fetcher });

    expect(code).toBe(0);
    expect(stdout).toContain("server: started token=[redacted]");
    expect(stdout).not.toContain("hidden");
  });

  test("supports custom addr and does not leak token on 401", async () => {
    const secret = "flag-secret";
    const fetcher = fetchStub((request) => {
      expect(request.url).toBe("http://127.0.0.1:3999/api/system/status");
      return jsonResponse({ message: `unauthorized ${secret}` }, 401);
    });
    const { code, stdout, stderr } = await run([
      "system", "status", "--addr", "127.0.0.1:3999", "--token", secret
    ], { fetcher });

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("[redacted]");
    expect(stderr).not.toContain(secret);
  });

});

async function run(args: string[], options: {
  env?: (key: string) => string | undefined;
  fetcher?: typeof fetch;
} = {}): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(args, stdout, stderr, { env: options.env ?? envMap({}), fetch: options.fetcher ?? fetchStub() });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

function fetchStub(handler: (request: Request) => Response | Promise<Response> = () => jsonResponse({ ok: true })): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return await handler(request);
  }) as typeof fetch;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status
  });
}

function systemStatusBody(): Record<string, unknown> {
  return {
    auth: { enabled: true },
    codex: { command_ok: true },
    config: { auth_enabled: true },
    connectors: [{ id: "feishu", status: "disabled" }],
    db: { ok: true },
    runner: { in_progress_issues: 1, running_loops: 2 },
    service: { alive: true }
  };
}

function envMap(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

async function tempTokenFile(token: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-cli-"));
  tempRoots.push(root);
  const path = join(root, "auth_token");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return path;
}

class MemoryWriter {
  text = "";

  write(chunk: Uint8Array | string): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}
