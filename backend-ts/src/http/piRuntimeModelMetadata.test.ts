import { describe, expect, test } from "bun:test";
import type { Model } from "@earendil-works/pi-ai";
import type { PiAgent } from "../db/repositories/pi.ts";
import { piRuntimeModelMetadata } from "./piRuntime.ts";

describe("PI runtime model metadata", () => {
  test("keeps vision enabled for custom GPT models missing built-in metadata", () => {
    const model = defaultCustomModel("openai-codex", "gpt-5.6-luna", "openai-codex-responses");

    expect(piRuntimeModelMetadata(model, agent("openai-codex", "gpt-5.6-luna")).input).toEqual([
      "text",
      "image"
    ]);
  });

  test("does not infer vision support for unrelated custom text models", () => {
    const model = defaultCustomModel("openai-codex", "text-model", "openai-codex-responses");

    expect(piRuntimeModelMetadata(model, agent("openai-codex", "text-model")).input).toEqual(["text"]);
  });
});

function defaultCustomModel(provider: string, id: string, api: string): Model<any> {
  return {
    api,
    baseUrl: "https://example.test",
    contextWindow: 128_000,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
    id,
    input: ["text"],
    maxTokens: 16_384,
    name: id,
    provider,
    reasoning: false
  };
}

function agent(modelProvider: string, modelID: string): PiAgent {
  return { model_id: modelID, model_provider: modelProvider } as PiAgent;
}
