import { expect, spyOn, test } from "bun:test";
import { background } from "./hubRuntime.ts";

test("background close-out tasks log failures instead of rejecting unhandled", async () => {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    background(() => { throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }); }, "nodes.close_lost_run_failed", "run-1");
    background(async () => { throw new Error("late"); }, "nodes.reattach_grace_failed", "");
    await Bun.sleep(0);
    expect(logged.mock.calls.map((call) => JSON.parse(String(call[0])))).toEqual([
      { event: "nodes.close_lost_run_failed", run_ref: "run-1", error: "database is locked" },
      { event: "nodes.reattach_grace_failed", error: "late" }
    ]);
  } finally {
    logged.mockRestore();
  }
});
