import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultRouter } from "../../http/server.ts";
import { type ProviderRunInput } from "../types.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import { roots, BASE_URL } from "./offlineAcceptanceFixtureBASE_URL.ts";

export function readyProbe(): QoderRuntimeProbe {
  return {
    installed: true,
    ready: true,
    status: {
      active_sessions: 0,
      api_key_configured: true,
      auth_configured: true,
      auth_mode: "pat-env",
      auth_source: "environment",
      executable_ready: true,
      mode: "sdk",
      platform_profile: {
        cli_version: "1.1.23",
        protocol_status: "expected",
        protocol_version: "1.2.0",
        sdk_ready: true,
        sdk_version: "1.0.23"
      },
      ready: true,
      version: "1.0.23"
    }
  };
}

export function runInput(issueId: number, prompt: string): ProviderRunInput {
  return {
    cwd: "/fixture/qoder-q6",
    issueId,
    onEvent: () => {},
    projectId: "qoder-q6",
    prompt
  };
}

export async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

export function request(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method = "GET",
  body?: unknown
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  }));
}
