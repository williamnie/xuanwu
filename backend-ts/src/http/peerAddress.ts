import { isIP } from "node:net";

/** Web 网关把真实对端地址写入此头；Core 只在直接对端是 loopback（即网关）时才信任它。 */
export const PEER_ADDRESS_HEADER = "x-xuanwu-peer-addr";

const peerAddresses = new WeakMap<Request, string>();

type RequestIPSource = { requestIP(request: Request): { address: string } | null };

export function recordRequestPeerAddress(request: Request, server: RequestIPSource | undefined): void {
  const address = server?.requestIP(request)?.address;
  if (address) peerAddresses.set(request, address);
}

/** 请求方的真实地址：经网关转发时取网关注入的头，否则取 TCP 对端。 */
export function requestPeerAddress(request: Request): string {
  const direct = peerAddresses.get(request) ?? "";
  const forwarded = request.headers.get(PEER_ADDRESS_HEADER)?.trim() ?? "";
  if (forwarded !== "" && isIP(forwarded) !== 0 && isLoopback(direct)) return forwarded;
  return direct;
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}
