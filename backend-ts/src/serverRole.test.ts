import { describe, expect, test } from "bun:test";
import { assertInternalCoreAddress, resolveServerRole } from "./serverRole.ts";

describe("server role", () => {
  test("keeps the one-process compatibility default", () => {
    expect(resolveServerRole([], {})).toEqual({ args: [], role: "all" });
  });

  test("accepts env and CLI roles while removing the selector from core config args", () => {
    expect(resolveServerRole(["--addr", "127.0.0.1:3009"], { CODEX_RUNNER_ROLE: "core" }))
      .toEqual({ args: ["--addr", "127.0.0.1:3009"], role: "core" });
    expect(resolveServerRole(["--role=web", "--web-dir", "/tmp/web"], { CODEX_RUNNER_ROLE: "all" }))
      .toEqual({ args: ["--web-dir", "/tmp/web"], role: "web" });
  });

  test("rejects invalid and empty roles", () => {
    expect(() => resolveServerRole(["--role", "writer"], {})).toThrow("Invalid server role");
    expect(() => resolveServerRole(["--role"], {})).toThrow("Missing value for --role");
  });

  test("rejects a publicly bound Core authority", () => {
    expect(() => assertInternalCoreAddress("0.0.0.0:3009")).toThrow("loopback/internal");
    expect(() => assertInternalCoreAddress("[::]:3009")).toThrow("loopback/internal");
    expect(() => assertInternalCoreAddress("127.0.0.1:3009")).not.toThrow();
  });
});
