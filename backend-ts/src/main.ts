const bootstrapInfo = {
  ok: true,
  service: "codex-issue-runner backend-ts bootstrap",
  defaultAddr: "127.0.0.1:3018",
  defaultStateDir: "data-bun",
  defaultDb: "data-bun/runner.db"
} as const;

console.log(JSON.stringify(bootstrapInfo, null, 2));
