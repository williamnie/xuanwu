import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("server entrypoint wiring", () => {
  test("passes executor providers into Feishu PI conversations", () => {
    const source = readFileSync(join(import.meta.dir, "main.ts"), "utf8");

    expect(source).toContain("runPiConversationPrompt({ bus, database, providers }");
  });
});
