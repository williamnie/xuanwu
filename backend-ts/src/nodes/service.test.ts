import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNodeCommand } from "./cli.ts";
import { currentNodeCommand, nodeServicePlan, writeNodeService } from "./service.ts";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xuanwu node home-"));
  roots.push(dir);
  return dir;
}

const config = { allowedRoots: ["/srv/code"], hubUrl: "http://100.64.0.1:8787", token: "xwn_secret" };

describe("node service", () => {
  test("linux installs a restarting systemd user unit and keeps the token out of it", async () => {
    const HOME = await home();
    const plan = nodeServicePlan(config, { command: ["/opt/xuanwu/bin/xuanwu", "node"], env: { HOME, PATH: "/usr/bin:/opt/my $tools" }, platform: "linux" });
    await writeNodeService(plan);

    const nodeJson = join(HOME, ".xuanwu", "node.json");
    expect(JSON.parse(await readFile(nodeJson, "utf8"))).toEqual({ hub: config.hubUrl, roots: ["/srv/code"], token: "xwn_secret" });
    expect((await stat(nodeJson)).mode & 0o777).toBe(0o600);
    const unit = await readFile(join(HOME, ".config", "systemd", "user", "xuanwu-node.service"), "utf8");
    expect(unit).not.toContain("xwn_secret");
    expect(unit).toContain("Restart=always");
    // 带空格的 HOME 与 PATH 中的 $ 按 systemd 规则转义。
    expect(unit).toContain(`ExecStart=/opt/xuanwu/bin/xuanwu node --config "${nodeJson}"`);
    expect(unit).toContain('Environment="PATH=/usr/bin:/opt/my $$tools"');
    expect(plan.start).toEqual([["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", "xuanwu-node"]]);
  });

  test("macOS installs a KeepAlive launch agent", async () => {
    const HOME = await home();
    const plan = nodeServicePlan(config, { command: ["/opt/xuanwu", "node"], env: { HOME, PATH: "/usr/bin" }, platform: "darwin", uid: 501 });
    await writeNodeService(plan);

    const plist = await readFile(join(HOME, "Library", "LaunchAgents", "com.xuanwu.node.plist"), "utf8");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).not.toContain("xwn_secret");
    expect(plan.start[0]).toEqual(["launchctl", "bootstrap", "gui/501", join(HOME, "Library", "LaunchAgents", "com.xuanwu.node.plist")]);
  });

  test("the start command matches how xuanwu is running", () => {
    expect(currentNodeCommand("/usr/local/bin/xuanwu", "/$bunfs/root/xuanwu")).toEqual(["/usr/local/bin/xuanwu", "node"]);
    expect(currentNodeCommand("/usr/bin/bun", "/repo/backend-ts/src/main.ts")).toEqual(["/usr/bin/bun", "run", "/repo/backend-ts/src/main.ts", "node"]);
  });

  test("install refuses to set up a node that may run nowhere", async () => {
    const HOME = await home();
    expect(await runNodeCommand(["install", "--hub", "http://h:1", "--token", "xwn_x"], { HOME, PATH: "/usr/bin" })).toBe(1);
  });
});
