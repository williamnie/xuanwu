import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { startServer } from "./http/server.ts";

const config = loadConfig();
const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
const server = await startServer(config, { database });

console.log(JSON.stringify({
  ok: true,
  service: "codex-issue-runner backend-ts",
  listen: `${server.hostname}:${server.port}`,
  config: {
    addr: config.addr,
    stateDir: config.stateDir,
    dbPath: database.path
  }
}, null, 2));
