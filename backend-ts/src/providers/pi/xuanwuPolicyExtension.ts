/**
 * Runner-owned Pi policy extension.
 * It forwards every built-in side-effect tool call through Pi's RPC UI protocol.
 * The host returns true only after deterministic policy evaluation or human approval.
 */
export default function xuanwuPolicyExtension(pi: {
  on(event: "tool_call", handler: (event: Record<string, unknown>, context: Record<string, any>) => Promise<unknown>): void;
}) {
  pi.on("tool_call", async (event, context) => {
    const toolName = text(event.toolName ?? event.tool_name ?? event.name).toLowerCase();
    if (["read", "grep", "find", "ls"].includes(toolName)) return undefined;
    const payload = JSON.stringify({
      contract: "xw.pi-policy-tool-call.v1",
      toolCallId: text(event.toolCallId ?? event.tool_call_id),
      toolName,
      input: record(event.input ?? event.args)
    });
    const confirmed = await Promise.resolve(context.ui.confirm(
      "Xuanwu execution policy",
      payload,
      { timeout: 5 * 60_000 }
    )).catch(() => false);
    return confirmed ? undefined : { block: true, reason: "Xuanwu execution policy denied this tool call" };
  });
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
