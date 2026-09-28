import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
// 独立技能脚本与发布包共享源码，无需宿主 TypeScript 或 SDK 依赖。
// @ts-expect-error Plain-JS optional skill package has no TypeScript declaration.
import { classifyReport, handleRpc, INPUT_SCHEMA } from "../../../../skills/jev-assist/scripts/server.mjs";
import { JEV_INPUT_SCHEMA } from "./registry.ts";

const input = { title: "错误报告", body: "打开页面报错，应该显示列表。" };
const base = { key: "jev-unit-test-credential", model: "jev-latest", mode: "assist" };
function data(confidence = 0.99) {
  const answer = (choice: string, keys: string[]) => ({ type: "choice", choice, confidence,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) });
  return { model: "jev-1.13.0", answers: {
    intent: answer("bug_report", ["bug_report", "change_request", "question", "unknown"]),
    information: answer("missing", ["supplied", "missing", "unknown"]),
    message_kind: answer("report", ["report", "supplement", "decision", "revision", "other"])
  } };
}
test("adapter emits typed advisory only for validated high-confidence answers; shadow and low confidence omit advice", async () => {
  const fetch = async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.redirect).toBe("error");
    expect(init.body).not.toContain(base.key);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${base.key}`);
    return Response.json(data());
  };
  expect(await classifyReport(input, { ...base, fetch })).toMatchObject({ status: "observed", reason: "advisory", advice: { intent: { choice: "bug_report" } } });
  const shadow = await classifyReport(input, { ...base, mode: "shadow", fetch });
  expect(shadow).toMatchObject({ status: "observed", reason: "shadow_only" }); expect(shadow).not.toHaveProperty("advice");
  const low = await classifyReport(input, { ...base, fetch: async () => Response.json(data(0.6)) });
  expect(low).toMatchObject({ reason: "low_confidence" }); expect(low).not.toHaveProperty("advice");
});

test("adapter rejects fabricated categories, malformed distributions and oversize responses without exposing raw errors", async () => {
  const invalid = data(); invalid.answers.intent.choice = "close_issue";
  expect(await classifyReport(input, { ...base, fetch: async () => Response.json(invalid) })).toMatchObject({ status: "unavailable", reason: "invalid_response" });
  invalid.answers.intent.choice = "bug_report"; invalid.answers.intent.probabilities.bug_report = 0.2;
  expect(await classifyReport(input, { ...base, fetch: async () => Response.json(invalid) })).toMatchObject({ status: "unavailable" });
  expect(await classifyReport(input, { ...base, fetch: async () => new Response("x".repeat(131073)) })).toMatchObject({ status: "unavailable" });
  const failure = await classifyReport(input, { ...base, fetch: async () => { throw new Error(base.key); } });
  expect(JSON.stringify(failure)).not.toContain(base.key);
  expect(await classifyReport(input, { ...base, fetch: async () => new Response(base.key, { status: 401 }) })).toMatchObject({ reason: "http_401" });
});

test("timeout covers response body reads, and invalid input/missing key never calls upstream", async () => {
  let calls = 0;
  const fetch = async () => { calls++; return Response.json(data()); };
  expect(await classifyReport(input, { ...base, key: "", fetch })).toMatchObject({ reason: "credential_missing" });
  expect(await classifyReport({ ...input, body: "x".repeat(12001) }, { ...base, fetch })).toMatchObject({ reason: "invalid_input" });
  expect(await classifyReport({ ...input, apiKey: "forbidden" }, { ...base, fetch })).toMatchObject({ reason: "invalid_input" });
  expect(calls).toBe(0);
  const started = performance.now();
  const result = await classifyReport(input, { ...base, timeoutMs: 500,
    fetch: async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } })) });
  expect(result.reason).toBe("timeout"); expect(performance.now() - started).toBeLessThan(1200);
});

test("MCP tools/list uses the same bounded schema as the host and produces a real JSON-RPC result", async () => {
  expect(INPUT_SCHEMA).toEqual(JEV_INPUT_SCHEMA);
  const response = await handleRpc({ id: 2, method: "tools/call", params: { name: "jev_classify_report", arguments: input } }, {
    ...base, fetch: async () => Response.json(data())
  });
  expect(response.result.structuredContent).toMatchObject({ status: "observed", reason: "advisory" });
  expect(response.result.isError).not.toBe(true);
});

test("standalone node MCP package runs without host modules or credentials", async () => {
  const command = Bun.which("node")!;
  const child = spawn(command, [resolve(import.meta.dir, "../../../../skills/jev-assist/scripts/server.mjs")], { env: { PATH: process.env.PATH }, stdio: "pipe" });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  child.stdin.end([
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jev_classify_report", arguments: input } }
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const exitCode = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  expect(exitCode).toBe(0); expect(stderr).toBe("");
  const messages = stdout.trim().split("\n").map(line => JSON.parse(line));
  expect(messages.find(message => message.id === 2).result.structuredContent).toMatchObject({ status: "unavailable", reason: "credential_missing" });
});
