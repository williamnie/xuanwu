import { describe, expect, test } from "bun:test";
import { CLAUDE_AGENT_SDK_VERSION, ClaudeSdkExecutorProvider, type ClaudeQuery, type ClaudeQueryFactory } from "./provider.ts";
import type { ProviderEvent } from "../types.ts";

import { cwd, sdkProvider, config, baseConfig, runInput, init, success, fromMessages, waitingQuery, waitFor } from "./sdkProviderTestFixtures.ts";
import { registerMetadataOnlyReadsNeverLoadOr } from "./sdkProviderMetadataOnlyReadsNeverLoadOr.cases.ts";
import { registerPreservesUnknownSDKEventsAndMaps } from "./sdkProviderPreservesUnknownSDKEventsAndMaps.cases.ts";



describe("Claude Agent SDK provider", () => {
  registerMetadataOnlyReadsNeverLoadOr();
  registerPreservesUnknownSDKEventsAndMaps();
});
