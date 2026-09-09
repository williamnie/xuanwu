import { expect, test } from "bun:test";
import { PiRpcTransport, type PiRpcEvent } from "./rpcTransport.ts";

function harness(maxFrameBytes: number) {
  const transport = new PiRpcTransport({ maxFrameBytes });
  const events: PiRpcEvent[] = [];
  transport.onEvent((event) => events.push(event));
  // 向真实解帧器注入任意网络分块，不启动外部 Provider。
  const internal = transport as unknown as { handleStdout(chunk: Buffer | string): void; stdoutBuffer: string };
  return { events, internal, push: (chunk: Buffer | string) => internal.handleStdout(chunk) };
}

test("unterminated RPC frames fail at the byte budget and discard further chunks", () => {
  const { events, internal, push } = harness(32);
  push("x".repeat(20));
  push("汉".repeat(5));
  expect(events).toEqual([{ type: "error", message: "pi rpc frame exceeds 32 byte limit" }]);
  expect(internal.stdoutBuffer).toBe("");
  push("x".repeat(100));
  expect(events).toHaveLength(1);
  expect(internal.stdoutBuffer).toBe("");
});

test("many valid frames in one chunk are bounded individually and split UTF-8 survives", () => {
  const { events, push } = harness(64);
  const text = JSON.stringify({ type: "text", text: "你好" }) + "\r\n";
  const bytes = Buffer.from(text);
  const split = bytes.indexOf(Buffer.from("你好")) + 1;
  push(bytes.subarray(0, split));
  push(bytes.subarray(split));
  push(text.repeat(100));
  expect(events).toHaveLength(101);
  expect(events.every((event) => event.type === "text" && event.text === "你好")).toBe(true);
});

test("a complete oversized JSON frame is rejected before parsing", () => {
  const { events, push } = harness(32);
  push(JSON.stringify({ type: "text", text: "a".repeat(64) }) + "\n");
  expect(events[0]?.type).toBe("error");
});
