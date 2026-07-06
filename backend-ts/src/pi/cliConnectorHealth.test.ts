import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkCliConnectorHealth } from "./cliConnectorHealth.ts";

const FIXTURE_DIR = join(import.meta.dir, "../../../docs/fixtures");

describe("CLI connector health", () => {
  test("runs the docs fixture health command without leaking its token", async () => {
    const report = await checkCliConnectorHealth({
      env: {
        FIXTURE_INBOX_TOKEN: "fixture-secret-token",
        PATH: process.env.PATH
      },
      manifestDirs: [FIXTURE_DIR]
    });
    const text = JSON.stringify(report);

    expect(report.connectors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "fixture-local-inbox",
        status: "configured",
        health: expect.objectContaining({ checked: true, ok: true, status: "succeeded" })
      })
    ]));
    expect(text).not.toContain("fixture-secret-token");
  });
});
