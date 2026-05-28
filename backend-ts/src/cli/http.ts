import type { CommonFlags } from "./common.ts";
import type { Fetcher } from "./types.ts";

export async function getJSON<T>(fetcher: Fetcher, flags: CommonFlags, path: string): Promise<T> {
  return requestJSON<T>(fetcher, flags, "GET", path);
}

export async function postJSON<T>(fetcher: Fetcher, flags: CommonFlags, path: string, body: unknown): Promise<T> {
  return requestJSON<T>(fetcher, flags, "POST", path, body);
}

export async function patchJSON<T>(fetcher: Fetcher, flags: CommonFlags, path: string, body: unknown): Promise<T> {
  return requestJSON<T>(fetcher, flags, "PATCH", path, body);
}

async function requestJSON<T>(
  fetcher: Fetcher,
  flags: CommonFlags,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  if (flags.token.trim() !== "") headers.set("authorization", `Bearer ${flags.token.trim()}`);
  const response = await fetcher(endpoint(flags.addr, path), {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method
  });
  if (!response.ok) throw new Error(redactKnownToken(await responseError(response), flags.token));
  return await response.json() as T;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { message?: unknown };
    if (typeof payload.message === "string" && payload.message.trim() !== "") {
      return `${response.status} ${response.statusText}: ${payload.message}`;
    }
  } catch {
    // fall through to plain text
  }
  const body = text.trim();
  return body === "" ? `${response.status} ${response.statusText}` : `${response.status} ${response.statusText}: ${body}`;
}

export function endpoint(addr: string, path: string): string {
  const base = addr.trim().replace(/\/+$/, "");
  const normalizedBase = /^https?:\/\//.test(base) ? base : `http://${base}`;
  return `${normalizedBase}${path.startsWith("/") ? path : `/${path}`}`;
}

function redactKnownToken(message: string, token: string): string {
  const secret = token.trim();
  if (secret === "") return message;
  return message.split(secret).join("[redacted]");
}
