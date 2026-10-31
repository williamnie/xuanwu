import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "./herdrTransport.ts";

export type HookBody = Record<string, any>;

/** 每个终端独立的临时 hooks，不修改用户或项目 settings.json。 */
export class HerdrHooks {
  readonly directory = mkdtempSync(join(tmpdir(), "xuanwu-herdr-"));
  readonly settings = join(this.directory, "settings.json");
  private readonly token = crypto.randomUUID();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(curl: string, sessionId: string, handle: (body: HookBody) => Promise<Record<string, unknown>>) {
    this.server = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 0, maxRequestBodySize: 1024 * 1024,
      fetch: async (request) => {
        if (request.method !== "POST" || request.headers.get("authorization") !== `Bearer ${this.token}`) return new Response(null, { status: 403 });
        try {
          const body = await request.json() as HookBody;
          // 子代理有自己的生命周期，不能把其 Stop 当成主会话结束。
          if (body.session_id !== sessionId) return new Response(null, { status: 409 });
          if (body.agent_id && ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"].includes(body.hook_event_name)) return Response.json({});
          return Response.json(await handle(body));
        } catch { return new Response(null, { status: 500 }); }
      }
    });
    const config = join(this.directory, "curl.conf");
    writeFileSync(config, `url = "http://127.0.0.1:${this.server.port}/"\nheader = "Authorization: Bearer ${this.token}"\nheader = "Content-Type: application/json"\n`, { mode: 0o600 });
    // curl -q 不读取用户 curlrc；禁用代理。失败返回 2，让 PreToolUse 拒绝执行，
    // 而不是在玄武掉线、审批超时后静默放行。token 仅保存在私有文件中。
    const command = `${shellQuote(curl)} -q --config ${shellQuote(config)} --noproxy '*' --silent --show-error --fail --max-time 310 --data-binary @- || exit 2`;
    const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "Stop", "SessionEnd"];
    writeFileSync(this.settings, JSON.stringify({ hooks: Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: "command", command, timeout: 315 }] }]])) }), { mode: 0o600 });
  }

  dispose(): void {
    this.server.stop(true);
    rmSync(this.directory, { recursive: true, force: true });
  }
}
