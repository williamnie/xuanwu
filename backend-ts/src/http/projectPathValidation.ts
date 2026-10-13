import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);

export async function validateProjectPath(value: string): Promise<{ path: string; exists: boolean; is_directory: boolean; is_git_repository: boolean; reason: string }> {
  const path = value.trim();
  const result = { path, exists: false, is_directory: false, is_git_repository: false, reason: "" };
  if (!path || path.length > 4096 || !isAbsolute(path) || path.includes("\0")) return { ...result, reason: "请填写项目目录的绝对路径" };
  try {
    const info = await stat(path);
    result.exists = true;
    result.is_directory = info.isDirectory();
  } catch { return { ...result, reason: "路径不存在或无法读取" }; }
  if (!result.is_directory) return { ...result, reason: "请选择目录" };
  try {
    const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    result.is_git_repository = stdout.trim() === "true";
  } catch { return { ...result, reason: "这个目录不是 Git 仓库" }; }
  return result;
}
