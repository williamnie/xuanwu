import type { ImChannelRegistry } from "../integrations/imChannelContracts.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

/** Registry-backed diagnostics; no provider client or secret is exposed. */
export function registerImChannelRoutes(router: Router, context: { registry: ImChannelRegistry }): void {
  router.get("/api/integrations/im/channels", () => json(context.registry.list().map((module) => ({
    capabilities: module.connector.manifest.capabilities.map((item) => item.id),
    configuration: module.configuration,
    display_name: module.connector.manifest.display_name,
    health: module.connector.health(),
    id: module.id,
    receiver: module.receiver.status()
  }))));
  const paths = new Set<string>();
  for (const module of context.registry.list()) {
    if (!module.callback) continue;
    if (paths.has(module.callback.path)) throw new Error(`duplicate im channel callback path: ${module.callback.path}`);
    paths.add(module.callback.path);
    router.post(module.callback.path, (request) => module.callback!.handle(request));
  }
}
