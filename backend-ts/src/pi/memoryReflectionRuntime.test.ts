import { expect, test } from "bun:test";
import { installMemoryReflectionBudget } from "./memoryReflectionRuntime.ts";
import { REFLECTION_LIMITS } from "./memoryReflectionQueue.ts";

function budgetFixture() {
  let listener: (event: any) => void = () => {};
  const sent: any[] = [];
  const agent = {
    streamFunction: (_model: any, _context: any, options: any) => { sent.push(options); return {} as any; },
    subscribe: (callback: any) => { listener = callback; return () => {}; }
  };
  const abort = new AbortController();
  const dispose = installMemoryReflectionBudget(agent as never, abort.signal);
  const send = (context = {}) => agent.streamFunction({}, context, {});
  const output = (text: string, tokens = 10) => listener({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], usage: { output: tokens }
  } });
  return { abort, dispose, output, send, sent };
}

test("reflection caps provider output tokens across calls and rejects exhausted or revoked budgets before another model call", () => {
  const { send, sent, output } = budgetFixture();
  send(); expect(sent[0].maxTokens).toBe(3000);
  output("one", 1000);
  send(); expect(sent[1].maxTokens).toBe(2000);
  output("two", 2000);
  expect(() => send()).toThrow("budget");
  expect(sent).toHaveLength(2);
  const revoked = budgetFixture();
  revoked.abort.abort(); expect(() => revoked.send()).toThrow(); expect(revoked.sent).toHaveLength(0);
});

test("input bytes include repeated context; tool loops, excessive output and provider overruns have hard limits", () => {
  const input = budgetFixture();
  input.send({ text: "a".repeat(REFLECTION_LIMITS.inputBytes / 2) });
  expect(() => input.send({ text: "a".repeat(REFLECTION_LIMITS.inputBytes / 2) })).toThrow("budget");
  expect(input.sent).toHaveLength(1);
  const looping = budgetFixture();
  for (let i = 0; i < REFLECTION_LIMITS.modelCalls; i++) looping.send();
  expect(() => looping.send()).toThrow("budget");
  const verbose = budgetFixture();
  expect(() => verbose.output("a".repeat(REFLECTION_LIMITS.outputBytes + 1))).toThrow("output budget");
  const tokens = budgetFixture();
  expect(() => tokens.output("a", REFLECTION_LIMITS.outputTokens + 1)).toThrow("output budget");
});
