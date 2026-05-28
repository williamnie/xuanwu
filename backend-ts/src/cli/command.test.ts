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
      expect(request.url).toBe("http://127.0.0.1:3018/api/system/status");
      expect(request.headers.get("authorization")).toBeNull();
      return jsonResponse(systemStatusBody());
    });
    const { code, stdout, stderr } = await run(["system", "status"], { fetcher });

    expect(code).toBe(0);
    expect(stdout).toBe("API alive=true db=true codex_cmd=true auth=true loops=2 in_progress=1\n");
    expect(stderr).toBe("");
  });

  test("pretty prints JSON and sends token from Bun env", async () => {
    const fetcher = fetchStub((request) => {
      expect(request.headers.get("authorization")).toBe("Bearer env-token");
      return jsonResponse(systemStatusBody());
    });
    const { code, stdout } = await run(["system", "status", "--json"], {
      env: envMap({ CODEX_RUNNER_BUN_AUTH_TOKEN: "env-token" }),
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
      expect(request.headers.get("authorization")).toBe("Bearer file-token");
      return jsonResponse(systemStatusBody());
    });
    const { code } = await run(["doctor"], {
      env: envMap({ CODEX_RUNNER_BUN_AUTH_TOKEN_FILE: file }),
      fetcher
    });

    expect(code).toBe(0);
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

  test("rejects unknown subcommands without falling into serve mode", async () => {
    const { code, stderr } = await run(["issue", "status"], { fetcher: fetchStub() });

    expect(code).toBe(1);
    expect(stderr).toContain("unknown command: issue");
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
    db: { ok: true },
    runner: { in_progress_issues: 1, running_loops: 2 },
    service: { alive: true }
  };
}

function envMap(values: Record<string, string>): (key: string) => string | undefined {
  return (key) => values[key];
}

async function tempTokenFile(token: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-cli-"));
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
