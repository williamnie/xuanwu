import { loadConfig } from "./config/env.ts";
import { startServer } from "./http/server.ts";

const config = loadConfig();
const server = await startServer(config);

console.log(JSON.stringify({
  ok: true,
  service: "codex-issue-runner backend-ts",
  listen: `${server.hostname}:${server.port}`,
  config: {
    addr: config.addr,
    stateDir: config.stateDir,
    dbPath: config.dbPath
  }
}, null, 2));
