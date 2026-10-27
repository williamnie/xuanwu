import { isIP } from "node:net";

/**
 * 判断对端地址是否属于内网：loopback、RFC1918、链路本地、Tailscale CGNAT(100.64/10)、IPv6 ULA。
 * 只用于页面提醒，不作为访问控制依据。
 */
export function isPrivateNetworkAddress(value: string): boolean {
  const address = unwrapAddress(value);
  const family = isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return false;
}

function unwrapAddress(value: string): string {
  let address = value.trim();
  if (address.startsWith("[") && address.includes("]")) address = address.slice(1, address.indexOf("]"));
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped?.[1] ?? address;
}

function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase();
  if (lower === "::1") return true;
  const first = Number.parseInt(lower.split(":")[0] || "0", 16);
  // fc00::/7 ULA（Tailscale 的 fd7a:115c:a1e0::/48 也在其中）与 fe80::/10 链路本地。
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
