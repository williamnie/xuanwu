import { errorResponse, isSqliteContention, jsonError } from "./errors.ts";

type Handler = (request: Request) => Response | Promise<Response>;
type HttpMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
type Route = { method: HttpMethod; path: string; handler: Handler };

const ROUTE_METHODS = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

export type Router = {
  delete(path: string, handler: Handler): void;
  get(path: string, handler: Handler): void;
  handle(request: Request): Promise<Response>;
  patch(path: string, handler: Handler): void;
  post(path: string, handler: Handler): void;
  put(path: string, handler: Handler): void;
};

export function createRouter(): Router {
  const routes: Route[] = [];
  const add = (method: HttpMethod, path: string, handler: Handler) => {
    routes.push({ method, path: normalizePath(path), handler });
  };

  return {
    delete: (path, handler) => add("DELETE", path, handler),
    get: (path, handler) => add("GET", path, handler),
    patch: (path, handler) => add("PATCH", path, handler),
    post: (path, handler) => add("POST", path, handler),
    put: (path, handler) => add("PUT", path, handler),
    handle: (request) => dispatch(routes, request)
  };
}

async function dispatch(routes: Route[], request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);
    const route = routes.find((item) => routeMatches(item.path, path) && item.method === request.method);
    if (route) return await route.handler(request);
    return missingRouteResponse(routes, path);
  } catch (error) {
    if (isSqliteContention(error)) {
      const url = new URL(request.url);
      console.warn(JSON.stringify({
        event: "sqlite.contention",
        method: request.method.slice(0, 12),
        path: url.pathname.slice(0, 160),
        policy: "bounded-fast-fail"
      }));
    }
    return errorResponse(error);
  }
}

function missingRouteResponse(routes: Route[], path: string): Response {
  const allowed = allowedMethods(routes, path);
  if (allowed.length > 0) {
    return jsonError(405, "method not allowed", { allow: allowed.join(", ") });
  }
  return jsonError(404, "not found");
}

function allowedMethods(routes: Route[], path: string): HttpMethod[] {
  return ROUTE_METHODS.filter((method) => routes.some((item) => routeMatches(item.path, path) && item.method === method));
}

function normalizePath(path: string): string {
  if (path === "") return "/";
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function routeMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  const patternParts = pathSegments(pattern);
  const pathParts = pathSegments(path);
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, index) => part === pathParts[index] || isParamSegment(part));
}

function pathSegments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function isParamSegment(segment: string): boolean {
  return segment.startsWith(":") && segment.length > 1;
}
