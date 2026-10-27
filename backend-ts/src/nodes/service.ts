import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { NodeCliConfig } from "./cli.ts";

export const NODE_SERVICE_NAME = "xuanwu-node";
export const NODE_LAUNCHD_LABEL = "com.xuanwu.node";

export type NodeServicePlan = {
  /** 写入的文件：节点配置（含密钥，0600）与服务定义。 */
  files: Array<{ content: string; mode: number; path: string }>;
  /** 启用 / 停用服务的命令，由使用者执行或经 --start 执行。 */
  start: string[][];
  stop: string[][];
};

type ServiceEnv = { HOME?: string; PATH?: string };

/**
 * 生成节点常驻服务：systemd 用户服务（Linux）或 launchd LaunchAgent（macOS），
 * 崩溃或重启后自动拉起。密钥只写入 0600 的 ~/.xuanwu/node.json，不出现在服务文件与进程参数中。
 */
export function nodeServicePlan(
  config: NodeCliConfig,
  options: { command: string[]; env?: ServiceEnv; platform?: NodeJS.Platform; uid?: number }
): NodeServicePlan {
  const home = options.env?.HOME || homedir();
  const path = options.env?.PATH || "/usr/local/bin:/usr/bin:/bin";
  const platform = options.platform ?? process.platform;
  const configPath = join(home, ".xuanwu", "node.json");
  const command = [...options.command, "--config", configPath];
  const configFile = {
    content: `${JSON.stringify({
      hub: config.hubUrl,
      ...(config.maxParallel ? { max_parallel: config.maxParallel } : {}),
      roots: config.allowedRoots,
      token: config.token
    }, null, 2)}\n`,
    mode: 0o600,
    path: configPath
  };
  if (platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", `${NODE_LAUNCHD_LABEL}.plist`);
    const target = `gui/${options.uid ?? process.getuid?.() ?? 501}`;
    return {
      files: [configFile, { content: launchdPlist(command, { HOME: home, PATH: path }, join(home, ".xuanwu", "logs")), mode: 0o644, path: plist }],
      start: [["launchctl", "bootstrap", target, plist], ["launchctl", "kickstart", "-k", `${target}/${NODE_LAUNCHD_LABEL}`]],
      stop: [["launchctl", "bootout", `${target}/${NODE_LAUNCHD_LABEL}`]]
    };
  }
  if (platform === "linux") {
    const unit = join(home, ".config", "systemd", "user", `${NODE_SERVICE_NAME}.service`);
    return {
      files: [configFile, { content: systemdUnit(command, { HOME: home, PATH: path }), mode: 0o644, path: unit }],
      start: [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", "--now", NODE_SERVICE_NAME]],
      stop: [["systemctl", "--user", "disable", "--now", NODE_SERVICE_NAME]]
    };
  }
  throw new Error(`xuanwu node install supports linux and macOS, not ${platform}`);
}

export async function writeNodeService(plan: NodeServicePlan): Promise<void> {
  // launchd 不会创建日志目录。
  await mkdir(join(dirname(plan.files[0]!.path), "logs"), { recursive: true });
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { mode: file.mode });
    await chmod(file.path, file.mode);
  }
}

/** 卸载只删除服务定义；节点配置保留，便于重新安装。 */
export async function removeNodeService(plan: NodeServicePlan): Promise<void> {
  for (const file of plan.files.slice(1)) await rm(file.path, { force: true });
}

/** 当前进程的启动方式：编译后的 xuanwu 二进制，或源码运行时的 bun + main.ts。 */
export function currentNodeCommand(execPath = process.execPath, main = Bun.main): string[] {
  return main.endsWith(".ts") ? [execPath, "run", main, "node"] : [execPath, "node"];
}

function systemdUnit(command: string[], env: Required<ServiceEnv>): string {
  return [
    "[Unit]",
    "Description=Xuanwu remote node",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    `Environment=${systemdQuote(`HOME=${env.HOME}`)}`,
    `Environment=${systemdQuote(`PATH=${env.PATH}`)}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

function launchdPlist(command: string[], env: Required<ServiceEnv>, logDir: string): string {
  const strings = (values: string[]) => values.map((value) => `    <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${NODE_LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${strings(command)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(env.HOME)}</string>
    <key>PATH</key>
    <string>${xmlEscape(env.PATH)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "node.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "node.err.log"))}</string>
</dict>
</plist>
`;
}

/** systemd 的引号规则：反斜杠与双引号转义，`$` 写成 `$$`，`%` 写成 `%%`。 */
function systemdQuote(value: string): string {
  const escaped = value.replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return /^[A-Za-z0-9_@+=:,./-]+$/.test(value) ? escaped : `"${escaped.replace(/(["\\])/g, "\\$1")}"`;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
