import { expect, test } from "bun:test";
import { installMemoryReflectionBudget } from "./memoryReflectionRuntime.ts";
import { REFLECTION_LIMITS } from "./memoryReflectionQueue.ts";
import { unknownReflectionUsage } from "./memoryReflectionTelemetry.ts";

function budgetFixture() {
  let listener: (event: any) => void = () => {};
  const sent: any[] = [];
  const agent = {
    streamFunction: (_model: any, _context: any, options: any) => { sent.push(options); return {} as any; },
    subscribe: (callback: any) => { listener = callback; return () => {}; }
  };
  const abort = new AbortController();
  const usage = unknownReflectionUsage();
  const dispose = installMemoryReflectionBudget(agent as never, abort.signal, usage);
  const send = (context = {}) => agent.streamFunction({}, context, {});
  const output = (text: string, tokens = 10) => listener({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], usage: { output: tokens }
  } });
  return { abort, dispose, output, send, sent, usage, emit: (event: unknown) => listener(event) };
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

test("reflection telemetry counts only dispatched calls and provider-reported usage, preserving unknown fields", () => {
  const f = budgetFixture();
  f.send({ text: "repeated context" });
  f.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one" }],
    usage: { input: 100, output: 10, cacheRead: 40, cacheWrite: 20, cost: { total: 0.003 } } } });
  f.send({ text: "repeated context" });
  f.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "two" }],
    usage: { input: 120, output: 20, cacheRead: 60, cacheWrite: 0, cost: { total: 0.002 } } } });
  expect(f.usage).toMatchObject({ model_calls: 2, completed_calls: 2, input_tokens: 220, output_tokens: 30,
    cache_read_tokens: 100, cache_write_tokens: 20, cost_usd: 0.005,
    input_bytes: 2 * Buffer.byteLength(JSON.stringify({ text: "repeated context" })) });
  const missing = budgetFixture();
  missing.send(); missing.output("no input usage");
  expect(missing.usage).toMatchObject({ input_tokens: null, cache_read_tokens: null, cost_usd: null, output_tokens: 10 });
  const exhausted = budgetFixture();
  for (let i = 0; i < REFLECTION_LIMITS.modelCalls; i++) exhausted.send();
  expect(() => exhausted.send()).toThrow("call budget");
  expect(exhausted.usage.model_calls).toBe(REFLECTION_LIMITS.modelCalls);
});
