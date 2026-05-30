import { describe, expect, test } from "bun:test";
import { commandMode } from "./mainMode.ts";

describe("Bun main command mode", () => {
  test("keeps no-arg and flag-first default serve compatibility", () => {
    expect(commandMode([])).toEqual({ serve: true, args: [], version: false });
    expect(commandMode(["--addr", "127.0.0.1:3999"])).toEqual({
      serve: true,
      args: ["--addr", "127.0.0.1:3999"],
      version: false
    });
  });

  test("accepts explicit serve and routes subcommands to CLI", () => {
    expect(commandMode(["serve", "--addr", "127.0.0.1:4018"])).toEqual({
      serve: true,
      args: ["--addr", "127.0.0.1:4018"],
      version: false
    });
    expect(commandMode(["issue", "status"])).toEqual({ serve: false, args: ["issue", "status"], version: false });
    expect(commandMode(["system", "status"])).toEqual({ serve: false, args: ["system", "status"], version: false });
  });

  test("handles top-level --version without starting serve mode", () => {
    expect(commandMode(["--version"])).toEqual({ serve: false, args: [], version: true });
  });
});
