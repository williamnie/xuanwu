import { expect, spyOn, test } from "bun:test";
import { installUnhandledRejectionLogger } from "./unhandledRejection.ts";

test("unhandled rejections are logged instead of left to Bun's default exit", () => {
  let handler: ((reason: unknown) => void) | undefined;
  installUnhandledRejectionLogger({ on: ((event: string, listener: (reason: unknown) => void) => {
    expect(event).toBe("unhandledRejection");
    handler = listener;
  }) as never });
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    handler?.(Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
    expect(JSON.parse(String(logged.mock.calls[0]?.[0]))).toEqual({
      event: "core.unhandled_rejection", error_name: "Error", error: "database is locked"
    });
  } finally {
    logged.mockRestore();
  }
});
