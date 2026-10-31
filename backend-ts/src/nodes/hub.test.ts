import { describe, expect, test } from "bun:test";
import { NodeHub, NodeOfflineError } from "./hub.ts";

function channel() {
  const frames: string[] = [];
  let closed = false;
  return {
    frames,
    get closed() { return closed; },
    close: () => { closed = true; },
    write: (frame: string) => {
      if (closed) return false;
      frames.push(frame);
      return true;
    }
  };
}

function commandID(frame: string): string {
  return (JSON.parse(frame.replace(/^data: /, "")) as { id: string }).id;
}

describe("NodeHub", () => {
  test("rejects requests to offline nodes", async () => {
    await expect(new NodeHub().request("node_a", "status.get", {})).rejects.toBeInstanceOf(NodeOfflineError);
  });

  test("resolves a request with the node's response and ignores responses from other nodes", async () => {
    const hub = new NodeHub();
    const a = channel();
    hub.attach("node_a", a);
    const pending = hub.request("node_a", "path.check", { path: "/x" });
    const id = commandID(a.frames[0]!);
    hub.receive("node_b", [{ type: "res", id, ok: true, result: "spoofed" }]);
    hub.receive("node_a", [{ type: "res", id, ok: true, result: { path: "/x" } }]);
    expect(await pending).toEqual({ path: "/x" });
  });

  test("propagates node errors and times out unanswered requests", async () => {
    const hub = new NodeHub();
    const a = channel();
    hub.attach("node_a", a);
    const failed = hub.request("node_a", "path.check", {});
    hub.receive("node_a", [{ type: "res", id: commandID(a.frames[0]!), ok: false, error: "outside roots" }]);
    await expect(failed).rejects.toThrow("outside roots");
    await expect(hub.request("node_a", "slow", {}, 5)).rejects.toThrow("did not answer slow");
  });

  test("a reconnect replaces the old channel without reporting the node offline", () => {
    const hub = new NodeHub();
    const statuses: Array<[string, boolean]> = [];
    hub.onStatusChange((id, online) => statuses.push([id, online]));
    const first = channel();
    const detachFirst = hub.attach("node_a", first);
    hub.attach("node_a", channel());
    detachFirst();
    expect(first.closed).toBe(true);
    expect(hub.isOnline("node_a")).toBe(true);
    expect(statuses).toEqual([["node_a", true]]);
  });

  test("detaching fails in-flight requests", async () => {
    const hub = new NodeHub();
    const detach = hub.attach("node_a", channel());
    const pending = hub.request("node_a", "run.start", {});
    detach();
    await expect(pending).rejects.toBeInstanceOf(NodeOfflineError);
    expect(hub.isOnline("node_a")).toBe(false);
  });

  test("delivers run events in order once and acks the highest seq", () => {
    const hub = new NodeHub();
    const seen: number[] = [];
    hub.subscribeRun("run_1", (_event, seq) => seen.push(seq));
    expect(hub.receive("node_a", [
      { type: "event", runRef: "run_1", seq: 1, event: {} },
      { type: "event", runRef: "run_1", seq: 2, event: {} }
    ])).toEqual({ run_1: 2 });
    // 断线重连后节点补发已确认的事件：只确认，不重复投递。
    expect(hub.receive("node_a", [
      { type: "event", runRef: "run_1", seq: 2, event: {} },
      { type: "event", runRef: "run_1", seq: 3, event: {} }
    ])).toEqual({ run_1: 3 });
    expect(seen).toEqual([1, 2, 3]);
  });
});
