import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { ProviderPromptImage, ProviderRunInput } from "../providers/types.ts";
import { NODE_SKILL_ROOT_TOKEN, type NodeRunStartParams } from "./protocol.ts";

const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_SKILL_FILES = 500;
const SKILL_DIRECTORY = /^[a-f0-9]{24}\/[a-f0-9-]{36}\/[a-z0-9-]+$/;
const COMPLETE_MARKER = ".xuanwu-complete";

/** 中心侧：把本机图片与托管 Skill 目录读成随 run.start 下发的内容，总量受限。 */
export async function packRunAttachments(input: ProviderRunInput): Promise<Pick<NodeRunStartParams, "images" | "skillPackages">> {
  let total = 0;
  const take = (bytes: number) => {
    total += bytes;
    if (total > MAX_ATTACHMENT_BYTES) throw new Error(`run attachments exceed ${MAX_ATTACHMENT_BYTES} bytes for a remote node`);
  };
  const images = [];
  for (const image of input.images ?? []) {
    const data = await readFile(image.path);
    take(data.byteLength);
    images.push({ data: data.toString("base64"), name: basename(image.path), ...(image.detail ? { detail: image.detail } : {}) });
  }
  const skillPackages = [];
  for (const pkg of input.skillPackages ?? []) {
    const files = [];
    for (const path of await listFiles(pkg.path)) {
      if (files.length >= MAX_SKILL_FILES) throw new Error(`skill ${pkg.directory} has more than ${MAX_SKILL_FILES} files`);
      const data = await readFile(join(pkg.path, path));
      take(data.byteLength);
      files.push({ data: data.toString("base64"), path });
    }
    skillPackages.push({ directory: pkg.directory, files });
  }
  return { ...(images.length > 0 ? { images } : {}), ...(skillPackages.length > 0 ? { skillPackages } : {}) };
}

/**
 * 节点侧：Skill 版本不可变，按目录缓存到 workDir/skills 下只写一次；图片写到本次运行的临时目录。
 * 返回替换了占位符与图片路径的运行输入，以及运行结束后的清理函数。
 */
export async function materializeRunAttachments(
  workDir: string,
  runRef: string,
  params: Pick<NodeRunStartParams, "images" | "skillPackages">,
  input: NodeRunStartParams["input"]
): Promise<{ cleanup: () => Promise<void>; images?: ProviderPromptImage[]; prompt: string }> {
  const skillsRoot = join(workDir, "skills");
  for (const pkg of params.skillPackages ?? []) {
    if (!SKILL_DIRECTORY.test(pkg.directory)) throw new Error("invalid skill package directory");
    const target = join(skillsRoot, pkg.directory);
    if (await exists(join(target, COMPLETE_MARKER))) continue;
    const staging = `${target}.staging-${runRef}`;
    await rm(staging, { force: true, recursive: true });
    for (const file of pkg.files) {
      const path = safeRelative(file.path);
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), Buffer.from(file.data, "base64"));
    }
    await writeFile(join(staging, COMPLETE_MARKER), "");
    await rm(target, { force: true, recursive: true });
    await mkdir(dirname(target), { recursive: true });
    await rename(staging, target);
  }
  const attachmentDir = join(workDir, "attachments", runRef.replace(/[^a-zA-Z0-9_-]/g, ""));
  const images: ProviderPromptImage[] = [];
  for (const [index, image] of (params.images ?? []).entries()) {
    await mkdir(attachmentDir, { recursive: true });
    const path = join(attachmentDir, `${index}-${basename(image.name) || "image"}`);
    await writeFile(path, Buffer.from(image.data, "base64"));
    images.push({ path, type: "localImage", ...(image.detail ? { detail: image.detail } : {}) });
  }
  return {
    cleanup: () => rm(attachmentDir, { force: true, recursive: true }),
    ...(images.length > 0 ? { images } : {}),
    prompt: input.prompt.replaceAll(NODE_SKILL_ROOT_TOKEN, skillsRoot)
  };
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function safeRelative(path: string): string {
  const normalized = normalize(path);
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith(`..${sep}`) || relative(".", normalized).startsWith("..")) {
    throw new Error("invalid skill file path");
  }
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await stat(path).catch(() => null));
}
