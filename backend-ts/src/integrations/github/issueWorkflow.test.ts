import { expect, test } from "bun:test";
import { sameObservedCommand } from "./issueWorkflow.ts";

test("matches provider shell envelopes without weakening command identity", () => {
  expect(sameObservedCommand("/bin/zsh -lc 'bun test src/test.ts'", "bun test src/test.ts")).toBe(true);
  expect(sameObservedCommand('/bin/bash -lc "git diff --exit-code && git status --short"', "git diff --exit-code && git status --short")).toBe(true);
  expect(sameObservedCommand('/bin/zsh -lc "printf \\"test\\""', 'printf "test"')).toBe(true);
  expect(sameObservedCommand("/bin/zsh -lc 'bun test src/a.ts'", "bun test src/b.ts")).toBe(false);
  expect(sameObservedCommand("/bin/zsh -lc 'bun test' ; true", "bun test")).toBe(false);
  expect(sameObservedCommand("/bin/zsh -lc 'echo bun test'", "bun test")).toBe(false);
  expect(sameObservedCommand("/bin/zsh -lc 'bun test || true'", "bun test")).toBe(false);
  expect(sameObservedCommand("/bin/zsh -lc 'bun test' extra", "bun test")).toBe(false);
});
