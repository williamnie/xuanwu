import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ReleaseUpdateCheck = {
  current: string;
  latest: string;
  update_available: boolean;
};

export async function checkReleaseUpdate(updaterPath: string): Promise<ReleaseUpdateCheck> {
  const result = await execFileAsync(updaterPath, ["check", "--json"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024,
    timeout: 15_000
  });
  return validateReleaseUpdateCheck(JSON.parse(result.stdout) as ReleaseUpdateCheck);
}

export function validateReleaseUpdateCheck(value: ReleaseUpdateCheck): ReleaseUpdateCheck {
  if (!value || typeof value.current !== "string" || typeof value.latest !== "string" ||
    typeof value.update_available !== "boolean" || !RELEASE_VERSION_PATTERN.test(value.latest)) {
    throw new Error("release update check returned invalid data");
  }
  return value;
}

export function defaultReleaseUpdaterPath(): string {
  return Bun.env.XUANWU_UPDATER_PATH || join(Bun.env.XUANWU_INSTALL_DIR || join(homedir(), ".local", "bin"), "xuanwu-update");
}
