import { asProviderId } from "../providers/types.ts";
import type { ProviderRegistry } from "../providers/core/registry.ts";
import { catalogEntryFromRegistry } from "../providers/core/catalog.ts";
import { json, jsonError } from "./errors.ts";
import type { Router } from "./router.ts";

/**
 * P6：/api/providers Provider discovery API（设计 §3.7 / 计划 P6）。
 * 新 Provider 注册后自动出现在 catalog（selector/Session UI 读取），无需前端改动；
 * 未注册 Provider 不进入任何可提交 selector；not-ready 可见但 submittable=false。
 */
export function registerProvidersCatalogRoute(
  router: Router,
  context: { providersRegistry?: ProviderRegistry }
): void {
  router.get("/api/providers", () => {
    if (!context.providersRegistry) return json([]);
    return json(context.providersRegistry.list().map(catalogEntryFromRegistry));
  });
  router.get("/api/providers/:id", (request: Request) => {
    if (!context.providersRegistry) return jsonError(404, "provider catalog unavailable");
    const id = decodeURIComponent(new URL(request.url).pathname.split("/").pop() ?? "");
    try {
      return json(catalogEntryFromRegistry(context.providersRegistry.describe(asProviderId(id))));
    } catch {
      return jsonError(404, `provider "${id}" is not registered`);
    }
  });
}
