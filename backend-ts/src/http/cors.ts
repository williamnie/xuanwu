import { jsonError } from "./errors.ts";

export function applyLocalCors(request: Request): Response | undefined {
  const origin = clean(request.headers.get("origin") ?? "");
  if (origin === "") return undefined;
  const directHost = request.headers.get("host") ?? "";
  const trustGateway = isLocalHostHeader(directHost);
  const host = trustGateway ? request.headers.get("x-forwarded-host") ?? directHost : directHost;
  const proto = trustGateway ? request.headers.get("x-forwarded-proto") ?? "http" : "http";
  if (!originAllowed(origin, host, proto)) return jsonError(403, "origin not allowed");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  return undefined;
}

export function withCors(request: Request, response: Response): Response {
  const origin = clean(request.headers.get("origin") ?? "");
  if (origin === "") return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Codex-Client",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Vary": "Origin"
  };
}

function originAllowed(origin: string, host: string, proto: string): boolean {
  try {
    const url = new URL(origin);
    const sameOrigin = requestOrigin(host, proto);
    return isLocalHost(url.hostname) || (sameOrigin !== "" && origin.toLowerCase() === sameOrigin.toLowerCase());
  } catch {
    return false;
  }
}

function requestOrigin(host: string, proto: string): string {
  const cleanProto = proto.trim().toLowerCase() === "https" ? "https" : "http";
  return clean(host) === "" ? "" : `${cleanProto}://${clean(host)}`;
}

function isLocalHost(host: string): boolean {
  const cleanHost = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return cleanHost === "localhost" || cleanHost === "127.0.0.1" || cleanHost === "::1";
}

function isLocalHostHeader(host: string): boolean {
  try {
    return isLocalHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function clean(value: string): string {
  return value.trim();
}
