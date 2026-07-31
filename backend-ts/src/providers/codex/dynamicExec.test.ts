import { describe, expect, test } from "bun:test";
import { codexDynamicExecObservation } from "./dynamicExec.ts";

describe("Codex dynamic exec observation", () => {
  test("recovers a terminal unified exec command without evaluating its JavaScript wrapper", () => {
    const input = [
      'const r = await tools.exec_command({"cmd":"node --test src/example.test.js","workdir":"/repo/frontend"});',
      "text(r.output);"
    ].join("\n");
    expect(codexDynamicExecObservation({
      arguments: input,
      contentItems: [{ type: "inputText", text: "Script completed\nWall time 0.4 seconds\nOutput:\n8 pass" }],
      durationMs: 420,
      id: "dynamic-1",
      status: "completed",
      success: true,
      tool: "exec",
      type: "dynamicToolCall"
    })).toEqual({
      aggregatedOutput: "Script completed\nWall time 0.4 seconds\nOutput:\n8 pass",
      command: "node --test src/example.test.js",
      cwd: "/repo/frontend",
      durationMs: 420,
      exitCode: 0,
      id: "dynamic-1",
      status: "completed",
      type: "commandExecution"
    });
  });

  test("fails closed for running or multi-command orchestration wrappers", () => {
    const running = {
      arguments: 'const r = await tools.exec_command({"cmd":"npm test"}); text(r.output);',
      contentItems: [{ type: "inputText", text: "Script running with cell ID 8" }],
      id: "dynamic-running",
      status: "completed",
      success: true,
      tool: "exec",
      type: "dynamicToolCall"
    };
    expect(codexDynamicExecObservation(running)).toBeUndefined();
    expect(codexDynamicExecObservation({
      ...running,
      arguments: [
        'const a = await tools.exec_command({"cmd":"npm test"});',
        'const b = await tools.exec_command({"cmd":"npm run build"});'
      ].join("\n"),
      contentItems: [{ type: "inputText", text: "Script completed\nOutput:\nok" }]
    })).toBeUndefined();
  });

  test("prefers an explicit nested command exit code over wrapper completion", () => {
    expect(codexDynamicExecObservation({
      arguments: 'const r = await tools.exec_command({"cmd":"bun test"}); text(JSON.stringify({exit_code:r.exit_code,output:r.output}));',
      contentItems: [{ type: "inputText", text: 'Script completed\nOutput:\n{"exit_code":1,"output":"1 fail"}' }],
      exitCode: 1,
      id: "dynamic-failed-test",
      status: "completed",
      success: true,
      tool: "exec",
      type: "dynamicToolCall"
    })).toMatchObject({
      exitCode: 1,
      status: "failed"
    });
  });
});
