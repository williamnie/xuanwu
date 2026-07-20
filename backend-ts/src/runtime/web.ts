import { bunBuildInfo } from "../buildInfo.ts";
import { loadWebGatewayConfig } from "../config/webGateway.ts";
import { startWebGateway } from "../http/webGateway.ts";

export async function startWebRuntime(args: string[]): Promise<void> {
  const config = loadWebGatewayConfig(args);
  const server = startWebGateway(config);
  installTerminationHandlers(server);
  const build = bunBuildInfo();
  console.log(JSON.stringify({
    ok: true,
    service: "codex-issue-runner gateway",
    role: "web",
    listen: `${server.hostname}:${server.port}`,
    core: config.coreAddr,
    webDir: config.webDir,
    build
  }, null, 2));
}

function installTerminationHandlers(server: { stop(closeActiveConnections?: boolean): void }): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", role: "web", signal }));
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
