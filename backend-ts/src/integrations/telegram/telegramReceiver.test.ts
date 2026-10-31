import { describe } from "bun:test";
import { createTestFixture } from "./telegramReceiver.testFixture.ts";
import { registerRecordsAPermanentMalformedUpdateCases } from "./telegramReceiver.cases-records-a-permanent-malformed-update.ts";
import { registerInvalidatesTheGetmeCacheWhenCases } from "./telegramReceiver.cases-invalidates-the-getme-cache-when.ts";

const fixture = createTestFixture();

describe("Telegram long-poll receiver", () => {
  registerRecordsAPermanentMalformedUpdateCases(fixture);
  registerInvalidatesTheGetmeCacheWhenCases(fixture);
});
