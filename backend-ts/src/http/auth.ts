import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { jsonError } from "./errors.ts";

type AuthConfig = {
  authToken?: string;
  authTokenFile?: string;
};

export type AuthTokenStatus = {
  configured: true;
  rotatable: boolean;
  source: "environment" | "file";
};

export type AuthTokenManager = {
  current(): string;
  refresh(): Promise<string>;
  rotate(): Promise<string>;
  status(): AuthTokenStatus;
};

export async function createAuthTokenManager(config: AuthConfig): Promise<AuthTokenManager> {
  const configured = clean(config.authToken);
  if (configured !== "") return fixedTokenManager(configured);
  const file = clean(config.authTokenFile);
  if (file === "") throw new Error("remote access authentication is not configured");
  return await fileTokenManager(file, await loadOrCreateAuthTokenFile(file));
}

export async function loadAuthToken(config: AuthConfig): Promise<string> {
  const configured = clean(config.authToken);
  if (configured !== "") return configured;
  const file = clean(config.authTokenFile);
  if (file === "") return "";
  return await readAuthTokenFile(file);
}

export function requireBearerAuth(request: Request, authToken: string): Response | undefined {
  const configured = clean(authToken);
  if (configured === "" || !isApiRequest(request) || isPublicIntegrationCallback(request)) return undefined;
  if (constantTimeEqual(requestToken(request), configured)) return undefined;
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

async function loadOrCreateAuthTokenFile(path: string): Promise<string> {
  try {
    const existing = clean(await readFile(path, "utf8"));
    if (existing === "") throw new Error("auth token file is empty");
    await chmod(path, 0o600);
    return existing;
  } catch (error) {
    if (!isMissingFile(error)) {
      if (error instanceof Error && error.message === "auth token file is empty") throw error;
      throw new Error("failed to initialize auth token file");
    }
  }

  await mkdir(dirname(path), { recursive: true });
  const generated = generateAuthToken();
  try {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${generated}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return generated;
  } catch (error) {
    if (!isAlreadyExists(error)) throw new Error("failed to initialize auth token file");
    const existing = await readConcurrentlyCreatedToken(path);
    await chmod(path, 0o600);
    return existing;
  }
}

async function readConcurrentlyCreatedToken(path: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = clean(await readFile(path, "utf8"));
    if (existing !== "") return existing;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("auth token file is empty");
}

function fixedTokenManager(token: string): AuthTokenManager {
  return {
    current: () => token,
    refresh: async () => token,
    rotate: async () => { throw new Error("environment-managed auth token cannot be rotated"); },
    status: () => ({ configured: true, rotatable: false, source: "environment" })
  };
}

async function fileTokenManager(path: string, initial: string): Promise<AuthTokenManager> {
  let current = initial;
  let rotation: Promise<string> | undefined;
  const refresh = async () => {
    try {
      const next = clean(await readFile(path, "utf8"));
      if (next === "") throw new Error("empty token");
      current = next;
      return current;
    } catch {
      throw new Error("failed to refresh auth token");
    }
  };
  const rotate = async () => {
    if (rotation) return await rotation;
    rotation = (async () => {
      const next = generateAuthToken();
      await replaceAuthTokenFile(path, next);
      current = next;
      return next;
    })();
    try {
      return await rotation;
    } finally {
      rotation = undefined;
    }
  };
  return {
    current: () => current,
    refresh,
    rotate,
    status: () => ({ configured: true, rotatable: true, source: "file" })
  };
}

async function replaceAuthTokenFile(path: string, token: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(`${token}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch {
    throw new Error("failed to rotate auth token");
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

function isApiRequest(request: Request): boolean {
  return new URL(request.url).pathname.startsWith("/api/");
}

function isPublicIntegrationCallback(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return request.method === "POST" && (
    pathname === "/api/integrations/feishu/events" ||
    pathname === "/api/integrations/webhook/events"
  );
}

function requestToken(request: Request): string {
  return requestBearerToken(request) || requestCookieToken(request);
}

function requestBearerToken(request: Request): string {
  const header = clean(request.headers.get("authorization") ?? "");
  if (!header.toLowerCase().startsWith("bearer ")) return "";
  return clean(header.slice("bearer ".length));
}

function requestCookieToken(request: Request): string {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.split("=");
    if (clean(rawName) !== "xuanwu_token") continue;
    return decodeCookieToken(rawValue.join("="));
  }
  return "";
}

function decodeCookieToken(value: string): string {
  try {
    return clean(decodeURIComponent(value));
  } catch {
    return clean(value);
  }
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

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
