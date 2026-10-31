import { bunBuildInfo } from "../buildInfo.ts";
import { parseListenAddress } from "../config/listenAddress.ts";
import type { WebGatewayConfig } from "../config/webGateway.ts";
import { applyLocalCors, withCors } from "./cors.ts";
import { json, jsonError } from "./errors.ts";
import { PEER_ADDRESS_HEADER } from "./peerAddress.ts";
import { staticWebResponse } from "./staticWeb.ts";

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
];

export function startWebGateway(config: WebGatewayConfig): ReturnType<typeof Bun.serve> {
  const address = parseListenAddress(config.addr);
  return Bun.serve({
    hostname: address.hostname,
    idleTimeout: 120,
    port: address.port,
    fetch: createWebGatewayHandler(config)
  });
}

type PeerAddressSource = { requestIP(request: Request): { address: string } | null };

export function createWebGatewayHandler(
  config: WebGatewayConfig
): (request: Request, server?: PeerAddressSource) => Promise<Response> {
  return async (request, server) => {
    const corsResponse = applyLocalCors(request);
    if (corsResponse) return corsResponse;
    const pathname = new URL(request.url).pathname;
    let response: Response;
    if (pathname === "/health") {
      const build = bunBuildInfo();
      response = json({ status: "ok" }, {
        headers: {
          "cache-control": "no-store",
          "x-xuanwu-build-stamp": build.stamp,
          "x-xuanwu-role": "web"
        }
      });
    } else if (pathname.startsWith("/api/")) {
      response = await proxyToCore(request, config, server?.requestIP(request)?.address ?? "");
    } else {
      response = await staticWebResponse(request, config.webDir) ?? jsonError(404, "not found");
    }
    return withCors(request, response);
  };
}

async function proxyToCore(request: Request, config: WebGatewayConfig, peerAddress: string): Promise<Response> {
  const upstreamUrl = coreRequestUrl(config.coreAddr, request.url);
  const headers = proxyRequestHeaders(request.headers, new URL(request.url), peerAddress);
  const timeout = new AbortController();
  const timeoutID = setTimeout(() => timeout.abort(), config.proxyTimeoutMs);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  try {
    const upstream = await fetch(upstreamUrl, {
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      headers,
      method: request.method,
      redirect: "manual",
      signal
    });
    clearTimeout(timeoutID);
    return proxyResponse(upstream);
  } catch (error) {
    clearTimeout(timeoutID);
    if (request.signal.aborted) throw error;
    return json({
      code: timeout.signal.aborted ? "core_timeout" : "core_unavailable",
      message: timeout.signal.aborted ? "runner core timed out" : "runner core unavailable"
    }, {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "1" }
    });
  }
}

function coreRequestUrl(coreAddr: string, requestUrl: string): string {
  const incoming = new URL(requestUrl);
  return new URL(`${incoming.pathname}${incoming.search}`, `${coreAddr}/`).toString();
}

function proxyRequestHeaders(source: Headers, requestUrl: URL, peerAddress: string): Headers {
  const headers = new Headers(source);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  // 客户端自带的同名头一律丢弃，只转发网关看到的 TCP 对端。
  headers.delete(PEER_ADDRESS_HEADER);
  if (peerAddress) headers.set(PEER_ADDRESS_HEADER, peerAddress);
  const host = source.get("host") || requestUrl.host;
  if (host) headers.set("x-forwarded-host", host);
  if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", requestUrl.protocol.replace(":", ""));
  return headers;
}

function proxyResponse(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  for (const name of HOP_BY_HOP_HEADERS) headers.delete(name);
  return new Response(upstream.body, {
    headers,
    status: upstream.status,
    statusText: upstream.statusText
  });
}
