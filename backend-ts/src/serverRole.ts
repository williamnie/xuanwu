export type ServerRole = "agentic" | "all" | "core" | "web";

type Env = Record<string, string | undefined>;

export function resolveServerRole(args: string[], env: Env = Bun.env): { args: string[]; role: ServerRole } {
  const remaining: string[] = [];
  let configured = clean(env.CODEX_RUNNER_ROLE) || "all";
  let cliRole = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--role") {
      const value = clean(args[index + 1]);
      if (value === "") throw new Error("Missing value for --role");
      cliRole = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--role=")) {
      cliRole = clean(arg.slice("--role=".length));
      if (cliRole === "") throw new Error("Missing value for --role");
      continue;
    }
    remaining.push(arg);
  }
  configured = cliRole || configured;
  if (!isServerRole(configured)) throw new Error(`Invalid server role: ${configured}; expected web, core, agentic, or all`);
  return { args: remaining, role: configured };
}

export function assertInternalCoreAddress(addr: string, service = "Core"): void {
  const hostname = addr.trim().slice(0, addr.trim().lastIndexOf(":"));
  if (["", "*", "0.0.0.0", "::", "[::]"].includes(hostname.toLowerCase())) {
    throw new Error(`${service} role must use a loopback/internal listen address, received: ${addr}`);
  }
}

function isServerRole(value: string): value is ServerRole {
  return value === "agentic" || value === "all" || value === "core" || value === "web";
}

function clean(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
