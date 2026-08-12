import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  WIRE_PROTOCOL_VERSION,
  type CanUseTool,
  type GetSessionMessagesOptions,
  type ListSessionsOptions,
  type ModelInfo,
  type Options,
  type Query,
  type SDKControlInterruptResponse,
  type SDKMirrorErrorMessage,
  type SDKResultMessage,
  type SDKSessionInfo,
  type SDKTaskNotificationMessage,
  type SessionMessage,
  type UsageInfo
} from "@qoder-ai/qoder-agent-sdk";
import { buildQoderAuthOptions, buildQoderQueryOptions, QODER_VERSION_PAIR, qoderMessageTerminal } from "./sdkFacade.ts";
import { buildConfig } from "../../config/env.ts";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;
type Expect<Value extends true> = Value;

type SdkExports = typeof import("@qoder-ai/qoder-agent-sdk");
type _ListSessionsContract = Expect<Equal<Awaited<ReturnType<SdkExports["listSessions"]>>, SDKSessionInfo[]>>;
type _ReadSessionContract = Expect<Equal<Awaited<ReturnType<SdkExports["getSessionInfo"]>>, SDKSessionInfo | undefined>>;
type _ReadMessagesContract = Expect<Equal<Awaited<ReturnType<SdkExports["getSessionMessages"]>>, SessionMessage[]>>;
type _InterruptContract = Expect<Equal<Awaited<ReturnType<Query["interrupt"]>>, SDKControlInterruptResponse | undefined>>;
type _ModelContract = Expect<Equal<Awaited<ReturnType<Query["getAvailableModels"]>>, ModelInfo[]>>;
type _UsageContract = Expect<Equal<Awaited<ReturnType<Query["getUsageInfo"]>>, UsageInfo | null>>;

const sessionListOptions = { dir: "/fixture/project", limit: 20, offset: 0 } satisfies ListSessionsOptions;
const sessionReadOptions = { dir: "/fixture/project", limit: 50, offset: 0, includeSystemMessages: true } satisfies GetSessionMessagesOptions;
const sessionInfo = {
  sessionId: "session-contract",
  summary: "fixture",
  lastModified: 1,
  cwd: "/fixture/project"
} satisfies SDKSessionInfo;
const sessionMessage = {
  type: "assistant",
  uuid: "assistant-1",
  session_id: "session-contract",
  message: { role: "assistant", content: [] },
  parent_tool_use_id: null,
  parent_agent_id: null
} satisfies SessionMessage;
const permissionCallback = (async (_toolName, _input, options) => ({
  behavior: "deny",
  message: options.decisionReason ?? "fixture deny",
  toolUseID: options.toolUseID
})) satisfies CanUseTool;
const queryOptions = {
  auth: { type: "qodercli" },
  model: "performance",
  resume: "session-contract",
  permissionMode: "dontAsk",
  canUseTool: permissionCallback
} satisfies Options;
const authOptions = [
  { type: "accessToken", accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" } },
  { type: "serviceAccount", serviceAccountKey: { envVar: "QODER_SERVICE_ACCOUNT_KEY" } },
  { type: "qodercli" }
] satisfies Array<NonNullable<Options["auth"]>>;

void sessionListOptions;
void sessionReadOptions;
void sessionInfo;
void sessionMessage;
void queryOptions;
void authOptions;

function usage(): SDKResultMessage["usage"] {
  return {
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    inference_geo: "",
    input_tokens: 5,
    iterations: [],
    output_tokens: 7,
    server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
    service_tier: "",
    speed: "",
    credits: 0.25,
    original_credits: 0.5,
    billable: true
  };
}

function result(overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    total_credits: 1.25,
    usage: usage(),
    modelUsage: {
      performance: {
        inputTokens: 5,
        outputTokens: 7,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
        webSearchRequests: 0,
        costUSD: 0,
        credits: 1.25,
        contextWindow: 200_000,
        maxOutputTokens: 32_000
      }
    },
    permission_denials: [],
    uuid: "result-1",
    session_id: "session-contract",
    ...overrides
  } as SDKResultMessage;
}

function taskNotification(status: SDKTaskNotificationMessage["status"]): SDKTaskNotificationMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "subagent-task-1",
    status,
    output_file: "",
    summary: "subagent done",
    usage: { total_tokens: 9, tool_uses: 1, duration_ms: 10 },
    uuid: `task-${status}`,
    session_id: "session-contract"
  };
}

describe("Qoder Q0: SDK/CLI freshness contract", () => {
  test("freezes the SDK-declared CLI pair and wire protocol without starting Qoder", async () => {
    const backendPackage = await Bun.file(resolve(import.meta.dir, "../../../package.json")).json();
    const sdkPackage = await Bun.file(resolve(import.meta.dir, "../../../node_modules/@qoder-ai/qoder-agent-sdk/package.json")).json();
    const cliPackage = await Bun.file(resolve(import.meta.dir, "../../../node_modules/@qoder-ai/qodercli/package.json")).json();
    const runtimeManifest = await Bun.file(resolve(
      import.meta.dir,
      "../../../node_modules/@qoder-ai/qoder-agent-sdk/dist/runtime-manifest.json"
    )).json();

    expect(backendPackage.dependencies["@qoder-ai/qoder-agent-sdk"]).toBe(QODER_VERSION_PAIR.sdk);
    expect(backendPackage.dependencies["@qoder-ai/qodercli"]).toBe(QODER_VERSION_PAIR.cli);
    expect(cliPackage.version).toBe(QODER_VERSION_PAIR.cli);
    expect({ sdk: sdkPackage.version, cli: sdkPackage.qoderCliVersion }).toEqual({
      sdk: QODER_VERSION_PAIR.sdk,
      cli: QODER_VERSION_PAIR.cli
    });
    expect(runtimeManifest).toMatchObject({
      sdkVersion: QODER_VERSION_PAIR.sdk,
      qoderCliVersion: QODER_VERSION_PAIR.cli
    });
    expect(WIRE_PROTOCOL_VERSION).toBe(QODER_VERSION_PAIR.wireProtocol);
  });

  test.each(["completed", "failed", "stopped"] as const)(
    "task_notification status=%s remains nonterminal for the main Run",
    (status) => {
      expect(qoderMessageTerminal(taskNotification(status))).toBeUndefined();
    }
  );

  test("SDKResultMessage is the authoritative main terminal", () => {
    expect(qoderMessageTerminal(result())).toBe("succeeded");
    expect(qoderMessageTerminal(result({ is_error: true }))).toBe("failed");
    expect(qoderMessageTerminal(result({
      subtype: "error_during_execution",
      is_error: true,
      errors: ["fixture failure"]
    }))).toBe("failed");
  });

  test("resume and new sessionId are distinct query options", () => {
    expect(buildQoderQueryOptions({ cwd: "/fixture/project", invocationKey: "inv-1", resume: "old-session", sessionId: "must-not-win", model: "performance" })).toMatchObject({
      cwd: "/fixture/project",
      model: "performance",
      resume: "old-session",
      sessionId: undefined
    });
    expect(buildQoderQueryOptions({ cwd: "/fixture/project", invocationKey: "inv-2", sessionId: "new-session" })).toMatchObject({
      cwd: "/fixture/project",
      model: undefined,
      resume: undefined,
      sessionId: "new-session"
    });
  });

  test("maps cwd, CLI, config dir, timeout-owned policy and system prompt without dropping fields", () => {
    const config = buildConfig({
      qoderAuthMode: "pat-env",
      qoderCommand: "/fixture/qodercli",
      qoderConfigDir: "/fixture/qoder-config",
      qoderModel: "performance",
      qoderPat: "fixture-pat"
    }).providers.qoder!;
    expect(buildQoderQueryOptions({
      approvalPolicy: "never",
      cwd: "/fixture/project",
      invocationKey: "inv-options",
      sandbox: "read-only",
      systemPrompt: "runner instructions"
    }, config)).toMatchObject({
      auth: { type: "accessToken", accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" } },
      cwd: "/fixture/project",
      disallowedTools: ["Agent", "Bash", "Edit", "NotebookEdit", "Write"],
      env: {
        QODER_CONFIG_DIR: "/fixture/qoder-config",
        QODER_PERSONAL_ACCESS_TOKEN: "fixture-pat",
        XUANWU_MANAGED_EXECUTION: "1"
      },
      model: "performance",
      pathToQoderCLIExecutable: "/fixture/qodercli",
      permissionMode: "dontAsk",
      systemPrompt: { type: "preset", preset: "qodercli", append: "runner instructions" }
    });
  });

  test("unsupported approval and unsafe sandbox policies fail closed", () => {
    expect(() => buildQoderQueryOptions({
      approvalPolicy: "danger-only", cwd: "/fixture/project", invocationKey: "inv-policy"
    })).toThrow("later approval integration");
    expect(() => buildQoderQueryOptions({
      cwd: "/fixture/project", invocationKey: "inv-sandbox", sandbox: "danger-full-access"
    })).toThrow("disabled");
  });

  test("maps four redacted Runner auth contracts to typed SDK auth", () => {
    const runtime = (authMode: string, credential = "") => buildConfig({
      qoderAuthMode: authMode,
      qoderCredential: credential,
      qoderCredentialRef: credential ? "secret://qoder/test" : undefined,
      qoderPat: authMode === "pat-env" ? "fixture-pat" : undefined
    }).providers.qoder!;
    expect(buildQoderAuthOptions(runtime("pat-env"))).toEqual({
      type: "accessToken", accessToken: { envVar: "QODER_PERSONAL_ACCESS_TOKEN" }
    });
    expect(buildQoderAuthOptions(runtime("pat-secret-ref", "fixture-pat"))).toEqual({
      type: "accessToken", accessToken: "fixture-pat"
    });
    expect(buildQoderAuthOptions(runtime("service-account-secret-ref", "fixture-service-account"))).toEqual({
      type: "serviceAccount", serviceAccountKey: "fixture-service-account"
    });
    expect(buildQoderAuthOptions(runtime("local-cli"))).toEqual({ type: "qodercli" });
  });

  test("non-result system messages never become a main terminal", () => {
    const mirrorError = {
      type: "system",
      subtype: "mirror_error",
      error: "fixture mirror error",
      key: { projectKey: "fixture-project", sessionId: "session-contract" },
      uuid: "mirror-1",
      session_id: "session-contract"
    } satisfies SDKMirrorErrorMessage;
    expect(qoderMessageTerminal(mirrorError)).toBeUndefined();
  });
});
