import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess } from "./jsonRpc.ts";
import { CodexProcessGroupLifecycle, type ProcessTreeEntry } from "./processLifecycle.ts";

import { FakeCodexProcess, FakeStdin, config, flushTimers, waitFor, encode } from "./jsonRpcTestFixtures.ts";
import { registerUsesA90SecondAppServer } from "./jsonRpcUsesA90SecondAppServer.cases.ts";
import { registerRoutesGrayCurrentWorkspaceCommandsThrough } from "./jsonRpcRoutesGrayCurrentWorkspaceCommandsThrough.cases.ts";
import { registerNormalizesAppServerNotificationEventsFrom } from "./jsonRpcNormalizesAppServerNotificationEventsFrom.cases.ts";



describe("Codex stdio JSON-RPC transport", () => {
  registerUsesA90SecondAppServer();
  registerRoutesGrayCurrentWorkspaceCommandsThrough();
  registerNormalizesAppServerNotificationEventsFrom();
});
