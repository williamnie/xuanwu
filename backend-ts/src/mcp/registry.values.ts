import { cleanString } from "../util/values.ts";
import type { McpRegistryDiagnostic } from "./registry.model.ts";

export function diagnostic(
  code: McpRegistryDiagnostic["code"],
  source: string,
  message: string,
  status = "",
  readiness = ""
): McpRegistryDiagnostic {
  return {
    code,
    message,
    ...(readiness === "" ? {} : { readiness }),
    server_id: code.startsWith("server_") ? source : "",
    severity: "warning",
    source_path: `mcp-registry:${source}`,
    ...(status === "" ? {} : { status })
  };
}

export function normalizeID(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function normalizeName(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
}
