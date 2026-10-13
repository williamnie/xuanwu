import { expect, test } from "bun:test";

test("inbox chronology normalizes legacy SQLite UTC and ISO offsets", async () => {
 const {inboxTimestamp}=await import("./inboxApi.ts");
 expect(inboxTimestamp("2026-10-13 05:00:00")).toBe(inboxTimestamp("2026-10-13T05:00:00Z"));
 expect(inboxTimestamp("2026-10-13 06:00:00")).toBeGreaterThan(inboxTimestamp("2026-10-13T05:30:00Z"));
 expect(inboxTimestamp("2026-10-13T13:00:00+08:00")).toBe(inboxTimestamp("2026-10-13T05:00:00Z"));
});
