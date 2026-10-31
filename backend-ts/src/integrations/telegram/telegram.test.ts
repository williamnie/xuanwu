import { describe } from "bun:test";
import { createTestFixture } from "./telegram.testFixture.ts";
import { registerParsesFailClosedConfigAndCases } from "./telegram.cases-parses-fail-closed-config-and.ts";
import { registerSplitsByParagraphThenUnicodeCases } from "./telegram.cases-splits-by-paragraph-then-unicode.ts";
import { registerRoutesCallbackResultPresentationThroughCases } from "./telegram.cases-routes-callback-result-presentation-through.ts";

const fixture = createTestFixture();

describe("Telegram channel adapter", () => {
  registerParsesFailClosedConfigAndCases(fixture);
  registerSplitsByParagraphThenUnicodeCases(fixture);
  registerRoutesCallbackResultPresentationThroughCases(fixture);
});
