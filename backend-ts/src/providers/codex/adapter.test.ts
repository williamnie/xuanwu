import { describe, expect, test } from "bun:test";
import { CodexAdapter, CodexThreadLifecycleError } from "./adapter.ts";
import type { JsonRpcParams } from "./jsonRpc.ts";

import { FakeRpc } from "./adapterTestFixtures.ts";
import { registerInitializesAndExposesAppServerVersion } from "./adapterInitializesAndExposesAppServerVersion.cases.ts";
import { registerReadsLightweightThreadMetadataAndPaginates } from "./adapterReadsLightweightThreadMetadataAndPaginates.cases.ts";



describe("Codex adapter RPC methods", () => {
  registerInitializesAndExposesAppServerVersion();
  registerReadsLightweightThreadMetadataAndPaginates();
});
