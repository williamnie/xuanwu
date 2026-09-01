import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { bunBuildInfo } from "../buildInfo.ts";

const execFileAsync = promisify(execFile);
export const RELEASE_VERSION_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type ReleaseUpdateCheck = {
  current: string;
  latest: string;
  update_available: boolean;
};

export async function checkReleaseUpdate(
  updaterPath: string,
  currentVersion = bunBuildInfo().version
): Promise<ReleaseUpdateCheck> {
  const result = await execFileAsync(updaterPath, ["check", "--json"], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024,
    timeout: 15_000
  });
  return releaseUpdateCheckForCurrent(JSON.parse(result.stdout) as ReleaseUpdateCheck, currentVersion);
}

export function releaseUpdateCheckForCurrent(value: ReleaseUpdateCheck, currentVersion: string): ReleaseUpdateCheck {
  const checked = validateReleaseUpdateCheck(value);
  const current = RELEASE_VERSION_PATTERN.test(currentVersion) ? currentVersion : checked.current;
  return { current, latest: checked.latest, update_available: isNewerRelease(current, checked.latest) };
}

export function isNewerRelease(current: string, latest: string): boolean {
  const left = semanticVersion(current);
  const right = semanticVersion(latest);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (right.core[index]! !== left.core[index]!) return right.core[index]! > left.core[index]!;
  }
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length > 0 && right.pre.length === 0;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.pre[index];
    const rightPart = right.pre[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined;
    if (leftPart === rightPart) continue;
    const leftNumber = numericIdentifier(leftPart);
    const rightNumber = numericIdentifier(rightPart);
    if (leftNumber !== null && rightNumber !== null) return rightNumber > leftNumber;
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null;
    return rightPart > leftPart;
  }
  return false;
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

function semanticVersion(value: string): { core: [number, number, number]; pre: string[] } | null {
  if (!RELEASE_VERSION_PATTERN.test(value)) return null;
  const withoutBuild = value.slice(1).split("+", 1)[0]!;
  const [coreText, ...preParts] = withoutBuild.split("-");
  const core = coreText.split(".").map(Number);
  if (core.length !== 3 || core.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  return { core: [core[0]!, core[1]!, core[2]!], pre: preParts.join("-").split(".").filter(Boolean) };
}

function numericIdentifier(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
