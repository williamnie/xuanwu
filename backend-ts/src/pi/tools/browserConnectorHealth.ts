import { BROWSER_READ_PAGE_CONTEXT_TOOL_NAME, BROWSER_READONLY_PROVIDER_ID, BROWSER_SNAPSHOT_ENV } from "./browserToolProvider.ts";
import { diagnoseBrowserSnapshot } from "./browserToolCall.ts";

export function browserConnectorHealth(env?: Record<string, string | undefined>): Record<string, unknown> {
  const diagnostic = diagnoseBrowserSnapshot(env ?? process.env);
  const status = connectorStatus(diagnostic.code, diagnostic.ok);
  const message = diagnostic.message;
  return {
    id: BROWSER_READONLY_PROVIDER_ID,
    label: "Browser read-only",
    kind: "browser",
    enabled: status === "configured",
    status,
    description: "Read authorized browser page context without click/type/form-submit/write capabilities.",
    settings_mode: "browser_snapshot",
    manifest_file: "built-in",
    command_count: 1,
    env: [{ configured: diagnostic.env_configured, name: BROWSER_SNAPSHOT_ENV, required: true, secret: true }],
    missing_required: diagnostic.env_configured ? [] : [BROWSER_SNAPSHOT_ENV],
    health: {
      checked: false,
      ok: diagnostic.ok,
      status: diagnostic.ok ? "succeeded" : "skipped",
      ...(diagnostic.ok ? {} : { error: { code: diagnostic.code, message } })
    },
    summary: {
      configured: diagnostic.ok,
      error: diagnostic.ok ? "" : message,
      page_count: diagnostic.page_count,
      read_only: true,
      state: status,
      tool: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME,
      unavailable_diagnostic: diagnostic.ok ? "" : diagnostic.code
    }
  };
}

function connectorStatus(code: string, ok: boolean): "configured" | "disabled" | "misconfigured" {
  if (ok) return "configured";
  if (code === "browser_unavailable" || code === "browser_no_pages") return "disabled";
  return "misconfigured";
}
