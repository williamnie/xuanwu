import type { RunnerConfig } from "../config/env.ts";
import { feishuConnectorStatus } from "../integrations/feishu.ts";
import { browserConnectorHealth } from "../pi/browserConnectorHealth.ts";
import { checkCliConnectorHealth } from "../pi/cliConnectorHealth.ts";
import { json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiConnectorHealthContext = {
  config?: RunnerConfig;
  env?: Record<string, string | undefined>;
};

export function registerPiConnectorHealthRoutes(router: Router, context: PiConnectorHealthContext): void {
  router.get("/api/pi/connectors", () => connectorHealthResponse(context));
  router.get("/api/pi/connectors/health", () => connectorHealthResponse(context));
}

async function connectorHealthResponse(context: PiConnectorHealthContext): Promise<Response> {
  const cli = await checkCliConnectorHealth({
    env: context.env,
    manifestDirs: context.config?.cliConnectors.manifestDirs ?? []
  });
  return json({
    connectors: [...staticConnectorStatuses(context), browserConnectorHealth(context.env), ...cli.connectors],
    diagnostics: cli.diagnostics,
    generated_at: new Date().toISOString()
  });
}

function staticConnectorStatuses(context: PiConnectorHealthContext): Array<Record<string, unknown>> {
  return context.config ? [feishuConnectorStatus(context.config.integrations.feishu)] : [];
}
