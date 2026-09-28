import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SkillLibraryError, type SkillSource } from "./managedTypes.ts";

const MAX_FILES = 512;
const MAX_BYTES = 16 * 1024 * 1024;
const SKIP = new Set([".git", "node_modules", ".DS_Store", ".xuanwu-skill.json"]);
const SECRET = /^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)|.*\.(?:pem|key|p12))$/i;

export function assertSkillResourcePath(path: string): void {
  if (path.split(/[\\/]/).some(name => SKIP.has(name) || (SECRET.test(name) && name !== ".env.example"))) throw new SkillLibraryError(400, "不允许读取技能中的凭据或内部管理文件");
}

export function normalizeSkillSource(value: unknown): SkillSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillLibraryError(400, "缺少技能来源");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["kind", "location", "ref", "subdirectory", "content"].includes(key))) throw new SkillLibraryError(400, "未知的技能来源字段");
  if (!["inline", "local", "git"].includes(String(input.kind))) throw new SkillLibraryError(400, "技能来源须为 inline、local 或 git");
  for (const key of ["location", "ref", "subdirectory", "content"]) {
    if (input[key] !== undefined && typeof input[key] !== "string") throw new SkillLibraryError(400, `${key} 必须为字符串`);
  }
  const source = { ...input } as SkillSource;
  if (source.kind === "inline") {
    if (!source.content || Buffer.byteLength(source.content) > 128 * 1024) throw new SkillLibraryError(400, "SKILL.md 内容不能为空或超过 128 KiB");
    if (source.location || source.ref || source.subdirectory) throw new SkillLibraryError(400, "inline 来源只接受 content");
  } else {
    if (!source.location || source.location.length > 4096 || source.content) throw new SkillLibraryError(400, "技能来源地址无效");
    if (source.kind === "local" && (!isAbsolute(source.location) || source.ref)) throw new SkillLibraryError(400, "本地来源需要绝对目录且不能指定 ref");
    if (source.kind === "git") normalizeGitSource(source);
    if (source.subdirectory) safeSubdirectory(source.subdirectory);
  }
  return source;
}

function normalizeGitSource(source: SkillSource): void {
  let url: URL;
  try { url = new URL(source.location!); } catch { throw new SkillLibraryError(400, "Git 来源需要 HTTPS 仓库地址"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port) throw new SkillLibraryError(400, "Git 来源仅支持无内嵌凭据的 HTTPS 地址");
  // 安装器只允许公共托管站点，避免通过来源 URL 请求本机或内网服务。
  if (!["github.com", "gitlab.com", "bitbucket.org"].includes(url.hostname)) throw new SkillLibraryError(400, "支持 GitHub、GitLab、Bitbucket 的 HTTPS 仓库；其他来源请先下载到本地");
  let parts: string[];
  try { parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); }
  catch { throw new SkillLibraryError(400, "Git 地址包含无效编码"); }
  if (url.hostname === "github.com" && parts[2] === "tree") {
    source.ref ||= parts[3];
    source.subdirectory ||= parts.slice(4).join("/");
    url.pathname = `/${parts[0]}/${parts[1]}`;
  }
  if (!url.pathname.match(/^\/[\w.-]+\/[\w./-]+$/)) throw new SkillLibraryError(400, "Git 仓库地址无效");
  if (source.ref && (!/^[\w./-]{1,200}$/.test(source.ref) || source.ref.startsWith("-") || source.ref.includes(".."))) throw new SkillLibraryError(400, "Git ref 无效");
  source.location = url.toString().replace(/\/$/, "");
}

function safeSubdirectory(value: string): string {
  if (value.length > 1024 || isAbsolute(value) || /[\\\0\r\n*?\[\]]/.test(value) || value.split("/").some(part => part === ".." || part === ".git")) throw new SkillLibraryError(400, "技能子目录必须位于来源目录内");
  return value;
}

export async function stageSkillSource(source: SkillSource, destination: string, scratch: string): Promise<{ digest: string; resolved_ref?: string; files: string[] }> {
  await mkdir(destination, { recursive: true });
  let resolved_ref: string | undefined;
  if (source.kind === "inline") await writeFile(join(destination, "SKILL.md"), source.content!, { flag: "wx", mode: 0o600 });
  else {
    const resolved = await resolveSkillSourceRoot(source, scratch);
    resolved_ref = resolved.resolved_ref;
    await copySkillTree(resolved.directory, destination);
  }
  return { ...await digestSkillTree(destination), resolved_ref };
}

export async function resolveSkillSourceRoot(source: SkillSource, scratch: string, metadataOnly = false): Promise<{ directory: string; resolved_ref?: string }> {
  let origin = source.location!, resolved_ref: string | undefined;
  if (source.kind === "git") {
    origin = join(scratch, "checkout");
    await mkdir(origin, { recursive: true });
    await git(["init", "--quiet", origin]);
    await git(["-C", origin, "remote", "add", "origin", source.location!]);
    await git(["-C", origin, "config", "remote.origin.promisor", "true"]);
    await git(["-C", origin, "config", "remote.origin.partialclonefilter", "blob:none"]);
    await git(["-C", origin, "fetch", "--filter=blob:none", "--depth", "1", "--no-tags", "origin", source.ref || "HEAD"]);
    if (metadataOnly || source.subdirectory) {
      await git(["-C", origin, "sparse-checkout", "set", "--no-cone", "--", metadataOnly ? "**/SKILL.md" : `/${safeSubdirectory(source.subdirectory!).replace(/^\/+|\/+$/g, "")}/`]);
    }
    await git(["-C", origin, "checkout", "--detach", "FETCH_HEAD"]);
    resolved_ref = (await git(["-C", origin, "rev-parse", "HEAD"])).trim();
  }
  const root = await realpath(origin).catch(() => { throw new SkillLibraryError(400, "本地技能目录不存在"); });
  const directory = await realpath(resolve(root, safeSubdirectory(source.subdirectory || ""))).catch(() => { throw new SkillLibraryError(400, "技能子目录不存在"); });
  if (!within(root, directory)) throw new SkillLibraryError(400, "技能子目录不能逃逸来源目录");
  return { directory, resolved_ref };
}

async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false", ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe"
  });
  const timer = setTimeout(() => proc.kill(), 45_000);
  try {
    const [exit, output] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    if (exit !== 0) throw new SkillLibraryError(400, "无法获取 Git 来源，请检查仓库、分支和网络；安装器不会执行认证交互或来源脚本");
    return output;
  } finally { clearTimeout(timer); }
}

async function copySkillTree(root: string, destination: string): Promise<void> {
  let bytes = 0, count = 0;
  async function walk(from: string, to: string, depth: number): Promise<void> {
    if (depth > 12) throw new SkillLibraryError(400, "技能目录层级过深");
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      if (SECRET.test(entry.name) && entry.name !== ".env.example") throw new SkillLibraryError(400, "技能包包含凭据文件，请先移除凭据");
      const source = join(from, entry.name), target = join(to, entry.name);
      const stat = await lstat(source);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new SkillLibraryError(400, "技能包不允许符号链接或特殊文件");
      if (++count > MAX_FILES) throw new SkillLibraryError(400, "技能包文件数量超过 512");
      if (stat.isDirectory()) { await mkdir(target); await walk(source, target, depth + 1); }
      else {
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw new SkillLibraryError(400, "技能包超过 16 MiB");
        const file = await Bun.file(source).arrayBuffer();
        // 再校验读取大小，拒绝复制过程中增长的文件。
        if (file.byteLength !== stat.size) throw new SkillLibraryError(409, "技能来源在读取过程中发生变化，请重试");
        await writeFile(target, Buffer.from(file), { flag: "wx", mode: stat.mode & 0o100 ? 0o700 : 0o600 });
      }
    }
  }
  await walk(root, destination, 0);
}

export async function digestSkillTree(root: string): Promise<{ digest: string; files: string[] }> {
  const hash = createHash("sha256"), files: string[] = [];
  let bytes = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12) throw new SkillLibraryError(400, "技能目录层级过深");
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new SkillLibraryError(400, "技能包不允许符号链接");
      if (stat.isDirectory()) await walk(path, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_BYTES || files.length >= MAX_FILES) throw new SkillLibraryError(400, "技能包超过大小限制");
        const relativePath = relative(root, path).split(sep).join("/");
        files.push(relativePath);
        hash.update(relativePath).update("\0").update(await readFile(path)).update("\0");
      } else throw new SkillLibraryError(400, "技能包包含特殊文件");
    }
  }
  await walk(root, 0);
  return { digest: hash.digest("hex"), files };
}

export function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}
