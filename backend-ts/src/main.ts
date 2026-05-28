import { loadConfig } from "./config/env.ts";

const config = loadConfig();
const bootstrapInfo = {
  ok: true,
  service: "codex-issue-runner backend-ts bootstrap",
  config: {
    addr: config.addr,
    stateDir: config.stateDir,
    dbPath: config.dbPath,
    authTokenFile: "<redacted>"
  }
} as const;

console.log(JSON.stringify(bootstrapInfo, null, 2));
