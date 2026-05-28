import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { jsonError } from "./errors.ts";

type AuthConfig = {
  authToken?: string;
  authTokenFile?: string;
};

export async function loadAuthToken(config: AuthConfig): Promise<string> {
  const configured = clean(config.authToken);
  if (configured !== "") return configured;
  const file = clean(config.authTokenFile);
  if (file === "") return "";
  return await readAuthTokenFile(file);
}

export function requireBearerAuth(request: Request, authToken: string): Response | undefined {
  const configured = clean(authToken);
  if (configured === "" || !isApiRequest(request)) return undefined;
  if (constantTimeEqual(requestBearerToken(request), configured)) return undefined;
  return jsonError(401, "unauthorized");
}

async function readAuthTokenFile(path: string): Promise<string> {
  try {
    return clean(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) return "";
    throw new Error("failed to read auth token file");
  }
}

function isApiRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/");
}

function requestBearerToken(request: Request): string {
  const header = clean(request.headers.get("authorization") ?? "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return clean(header.slice("bearer ".length));
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function constantTimeEqual(value: string, expected: string): boolean {
  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);
  return valueBuffer.length === expectedBuffer.length && timingSafeEqual(valueBuffer, expectedBuffer);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
