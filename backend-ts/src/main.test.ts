import { describe, expect, test } from "bun:test";
import { commandMode } from "./mainMode.ts";

describe("Bun main command mode", () => {
  test("keeps no-arg and flag-first default serve compatibility", () => {
    expect(commandMode([])).toEqual({ serve: true, args: [] });
    expect(commandMode(["--addr", "127.0.0.1:3999"])).toEqual({
      serve: true,
      args: ["--addr", "127.0.0.1:3999"]
    });
  });

  test("accepts explicit serve and routes subcommands to CLI", () => {
    expect(commandMode(["serve", "--addr", "127.0.0.1:4018"])).toEqual({
      serve: true,
      args: ["--addr", "127.0.0.1:4018"]
    });
    expect(commandMode(["issue", "status"])).toEqual({ serve: false, args: ["issue", "status"] });
    expect(commandMode(["system", "status"])).toEqual({ serve: false, args: ["system", "status"] });
  });
});
