import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp"
};

export async function staticWebResponse(request: Request, webDir: string): Promise<Response | undefined> {
  const root = cleanWebRoot(webDir);
  if (!root || !isStaticMethod(request.method)) return undefined;
  const target = staticTarget(root, requestPath(request));
  if (!target) return undefined;
  return fileResponse(request, target);
}

function staticTarget(root: string, pathname: string): string | undefined {
  const candidate = resolveRequestPath(root, pathname);
  if (isRegularFile(candidate)) return candidate;
  const index = join(root, "index.html");
  return isRegularFile(index) ? index : undefined;
}

function fileResponse(request: Request, path: string): Response {
  const headers = new Headers({ "content-type": contentType(path) });
  if (request.method === "HEAD") return new Response(null, { headers });
  const body = readFileSync(path);
  headers.set("content-length", String(body.byteLength));
  return new Response(body, { headers });
}

function resolveRequestPath(root: string, pathname: string): string {
  const decoded = decodePathname(pathname);
  const clean = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const target = resolve(root, clean);
  return isInside(root, target) ? target : join(root, "index.html");
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return "/";
  }
}

function requestPath(request: Request): string {
  return new URL(request.url).pathname;
}

function cleanWebRoot(webDir: string): string {
  const trimmed = webDir.trim();
  return trimmed === "" ? "" : resolve(trimmed);
}

function isStaticMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}
