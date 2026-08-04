import { describe, expect, test } from "bun:test";
import { DEFAULT_CORE_ADDR, DEFAULT_PROXY_TIMEOUT_MS, loadWebGatewayConfig } from "./webGateway.ts";

describe("Web Gateway config", () => {
  test("has an explicit internal core default without DB/provider config", () => {
    expect(loadWebGatewayConfig([], {})).toEqual({
      addr: "127.0.0.1:3008",
      coreAddr: `http://${DEFAULT_CORE_ADDR}`,
      proxyTimeoutMs: DEFAULT_PROXY_TIMEOUT_MS,
      webDir: ""
    });
  });

  test("CLI overrides env and normalizes core URLs", () => {
    expect(loadWebGatewayConfig([
      "--addr=0.0.0.0:3008",
      "--core-addr", "http://127.0.0.1:3909/",
      "--proxy-timeout-ms", "1500",
      "--web-dir", "/tmp/web"
    ], {
      XUANWU_ADDR: "127.0.0.1:4008",
      XUANWU_CORE_ADDR: "127.0.0.1:4009"
    })).toEqual({
      addr: "0.0.0.0:3008",
      coreAddr: "http://127.0.0.1:3909",
      proxyTimeoutMs: 1500,
      webDir: "/tmp/web"
    });
  });

  test("rejects core-only flags", () => {
    expect(() => loadWebGatewayConfig(["--db", "/tmp/runner.db"], {}))
      .toThrow("Unknown Web Gateway argument");
  });
});
