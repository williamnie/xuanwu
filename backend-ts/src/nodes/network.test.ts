import { describe, expect, test } from "bun:test";
import { isPrivateNetworkAddress } from "./network.ts";

describe("isPrivateNetworkAddress", () => {
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.10", "169.254.1.1",
    "100.64.0.1", "100.127.255.255", "::1", "fd7a:115c:a1e0::1", "fe80::1%en0", "::ffff:192.168.0.2", "[::1]"
  ])("treats %s as private", (address) => {
    expect(isPrivateNetworkAddress(address)).toBe(true);
  });

  test.each(["8.8.8.8", "172.32.0.1", "100.128.0.1", "100.63.255.255", "2001:4860::8888", "", "not-an-ip"])(
    "treats %s as public or unknown",
    (address) => {
      expect(isPrivateNetworkAddress(address)).toBe(false);
    }
  );
});
