import { cleanString, objectValue } from "../../util/values.ts";

/**
 * Runner-owned Pi policy extension.
 * It forwards every built-in side-effect tool call through Pi's RPC UI protocol.
 * The host returns true only after deterministic policy evaluation or human approval.
 */
export default function xuanwuPolicyExtension(pi: {
  on(event: "tool_call", handler: (event: Record<string, unknown>, context: Record<string, any>) => Promise<unknown>): void;
}) {
  pi.on("tool_call", async (event, context) => {
    const toolName = cleanString(event.toolName ?? event.tool_name ?? event.name).toLowerCase();
    if (["read", "grep", "find", "ls"].includes(toolName)) return undefined;
    const payload = JSON.stringify({
      contract: "xw.pi-policy-tool-call.v1",
      toolCallId: cleanString(event.toolCallId ?? event.tool_call_id),
      toolName,
      input: objectValue(event.input ?? event.args)
    });
    const confirmed = await Promise.resolve(context.ui.confirm(
      "Xuanwu execution policy",
      payload,
      { timeout: 5 * 60_000 }
    )).catch(() => false);
    return confirmed ? undefined : { block: true, reason: "Xuanwu execution policy denied this tool call" };
  });
}
