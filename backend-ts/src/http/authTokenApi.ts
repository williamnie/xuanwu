import type { AuthTokenManager } from "./auth.ts";
import { json, jsonError } from "./errors.ts";
import type { Router } from "./router.ts";

type AuthTokenRoutesContext = {
  manager: AuthTokenManager;
};

export function registerAuthTokenRoutes(router: Router, context: AuthTokenRoutesContext): void {
  router.get("/api/auth/token", () => noStore(context.manager.status()));
  router.post("/api/auth/token/rotate", async (request) => {
    const body = await readBody(request);
    if (body.confirm !== "rotate") return jsonError(400, "token rotation confirmation is required");
    if (!context.manager.status().rotatable) {
      return jsonError(409, "environment-managed auth token cannot be rotated from the UI");
    }
    const token = await context.manager.rotate();
    console.info(JSON.stringify({
      audit: {
        action: "auth.token.rotate",
        actor: "authorized_api",
        at: new Date().toISOString(),
        outcome: "applied",
        source: "settings"
      }
    }));
    return noStore({
      ok: true,
      shown_once: true,
      source: "file",
      token
    });
  });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function noStore(value: unknown): Response {
  return json(value, { headers: { "cache-control": "no-store" } });
}
