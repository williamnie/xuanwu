import { describe, expect, test } from "bun:test";
import { createImConversationCoordinator } from "./imConversationCoordinator.ts";

describe("generic IM conversation coordinator", () => {
  test("orders ack, preparation, one PI run and one reply", async () => {
    const calls: string[] = [];
    const coordinator = createImConversationCoordinator<{ id: string }, string, { text: string }>({
      acknowledge: async () => { calls.push("ack"); },
      alreadyHandled: () => false,
      dedupeKey: (input) => input.id,
      policy: () => "",
      prepare: () => { calls.push("prepare"); return "scope"; },
      reply: async () => { calls.push("reply"); return { reason: "sent", replied: true }; },
      run: async () => { calls.push("run"); return { text: "done" }; },
      text: (run) => run.text
    });
    expect(await coordinator.handle({ id: "m1" })).toEqual({ reason: "sent", replied: true });
    expect(calls).toEqual(["ack", "prepare", "run", "reply"]);
  });

  test("fails closed on policy, durable replay and concurrent replay", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createImConversationCoordinator<{ id: string; policy?: string; replay?: boolean }, null, { text: string }>({
      acknowledge: async () => undefined,
      alreadyHandled: (input) => input.replay === true,
      dedupeKey: (input) => input.id,
      policy: (input) => input.policy ?? "",
      prepare: () => null,
      reply: async () => ({ reason: "sent", replied: true }),
      run: async () => { await wait; return { text: "done" }; },
      text: (run) => run.text
    });
    expect(await coordinator.handle({ id: "blocked", policy: "ignored" })).toEqual({ reason: "ignored", replied: false });
    expect(await coordinator.handle({ id: "replay", replay: true })).toEqual({ reason: "duplicate_reply", replied: false });
    const first = coordinator.handle({ id: "same" });
    expect(await coordinator.handle({ id: "same" })).toEqual({ reason: "duplicate_reply_in_flight", replied: false });
    release();
    expect(await first).toEqual({ reason: "sent", replied: true });
  });
});
