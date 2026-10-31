import { describe } from "bun:test";
import { createTestFixture } from "./piConversationMessagesApi.testFixture.ts";
import { registerGlobalChatInvokesHumanAcceptanceCases } from "./piConversationMessagesApi.cases-global-chat-invokes-human-acceptance.ts";
import { registerManualContextToolReturnsACases } from "./piConversationMessagesApi.cases-manual-context-tool-returns-a.ts";
import { registerDerivesTelegramRunnerChatAuthorityCases } from "./piConversationMessagesApi.cases-derives-telegram-runner-chat-authority.ts";

const fixture = createTestFixture();

describe("Bun PI conversation message API", () => {
  registerGlobalChatInvokesHumanAcceptanceCases(fixture);
  registerManualContextToolReturnsACases(fixture);
  registerDerivesTelegramRunnerChatAuthorityCases(fixture);
});
