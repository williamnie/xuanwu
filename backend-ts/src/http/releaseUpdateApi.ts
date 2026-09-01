import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { bunBuildInfo } from "../buildInfo.ts";
import {
  checkReleaseUpdate,
  defaultReleaseUpdaterPath,
  RELEASE_VERSION_PATTERN,
  validateReleaseUpdateCheck,
  type ReleaseUpdateCheck
} from "../release/releaseUpdateCheck.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

const execFileAsync = promisify(execFile);
const CHECK_TTL_MS = 5 * 60 * 1000;

export type ReleaseUpdateContext = {
  checkUpdate?: () => Promise<ReleaseUpdateCheck>;
  jobID?: () => string;
  now?: () => Date;
  releaseInstall?: boolean;
  stateDir: string;
  triggerUpdate?: () => Promise<void>;
  updaterPath?: string;
};

type ReleaseUpdateJob = {
  backup_ref: string;
  created_at: string;
  error_code: string;
  from_version: string;
  id: string;
  state: string;
  target_version: string;
  updated_at: string;
};

export function registerReleaseUpdateRoutes(router: Router, input: ReleaseUpdateContext): void {
  const controller = new ReleaseUpdateController(input);
  router.get("/api/system/update", async (request) => json(
    await controller.status(new URL(request.url).searchParams.get("refresh") === "1")
  ));
  router.post("/api/system/update", async (request) => {
    const body = await parseJsonBody(request) as Record<string, unknown>;
    if (body.confirm !== "upgrade") throw new HttpError(400, "upgrade confirmation is required");
    return json(await controller.enqueue(String(body.version ?? "")), { status: 202 });
  });
}

export class ReleaseUpdateController {
  private readonly context: Required<Pick<ReleaseUpdateContext, "jobID" | "now">> & ReleaseUpdateContext;
  private cachedCheck: ReleaseUpdateCheck | null = null;
  private checkExpiresAt = 0;
  private checkPromise: Promise<ReleaseUpdateCheck> | null = null;

  constructor(context: ReleaseUpdateContext) {
    this.context = {
      ...context,
      jobID: context.jobID ?? randomUUID,
      now: context.now ?? (() => new Date()),
      updaterPath: context.updaterPath ?? defaultReleaseUpdaterPath()
    };
  }

  async status(refresh = false): Promise<Record<string, unknown>> {
    const supported = this.supported();
    const job = await this.latestJob();
    if (!supported) {
      return {
        check_error: "当前不是支持 UI 升级的 Release 安装",
        current: bunBuildInfo().version,
        job,
        latest: "",
        release_install: false,
        supported: false,
        update_available: false
      };
    }
    try {
      const check = await this.check(refresh);
      return { ...check, check_error: "", job, release_install: true, supported: true };
    } catch (error) {
      return {
        check_error: safeError(error),
        current: bunBuildInfo().version,
        job,
        latest: "",
        release_install: true,
        supported: true,
        update_available: false
      };
    }
  }

  async enqueue(requestedVersion: string): Promise<Record<string, unknown>> {
    if (!this.supported()) throw new HttpError(409, "当前不是支持 UI 升级的 Release 安装");
    if (!RELEASE_VERSION_PATTERN.test(requestedVersion)) throw new HttpError(400, "release version is invalid");
    if (await this.activeJobID()) throw new HttpError(409, "已有升级任务正在执行");
    const check = await this.check(true);
    if (!check.update_available) throw new HttpError(409, "当前已经是最新版本");
    if (check.latest !== requestedVersion) throw new HttpError(409, "目标版本已变化，请刷新后重试");
    if (!RELEASE_VERSION_PATTERN.test(check.current) || !RELEASE_VERSION_PATTERN.test(check.latest)) {
      throw new HttpError(409, "当前安装版本无法安全参与自动升级");
    }

    const id = this.context.jobID();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(id)) throw new Error("generated release update job id is invalid");
    const now = this.context.now().toISOString();
    const jobsDir = this.jobsDir();
    const jobDir = join(jobsDir, id);
    await mkdir(jobsDir, { recursive: true, mode: 0o700 });
    await chmod(jobsDir, 0o700);
    await mkdir(jobDir, { recursive: false, mode: 0o700 });
    await Promise.all([
      writeField(jobDir, "created_at", now),
      writeField(jobDir, "from_version", check.current),
      writeField(jobDir, "state", "pending"),
      writeField(jobDir, "target_version", check.latest),
      writeField(jobDir, "updated_at", now)
    ]);
    await writePointer(jobsDir, "latest", id);
    await writePointer(jobsDir, "pending", id);
    try {
      await (this.context.triggerUpdate ?? defaultTriggerUpdate)();
    } catch (error) {
      await writeField(jobDir, "state", "failed");
      await writeField(jobDir, "error_code", "updater_start_failed");
      await writeField(jobDir, "updated_at", this.context.now().toISOString());
      await removePointerIfMatches(jobsDir, "pending", id);
      throw new HttpError(503, `无法启动独立升级服务：${safeError(error)}`);
    }
    return {
      accepted: true,
      job: await readJob(jobDir, id),
      message: "升级任务已启动；服务会在备份验证后短暂重启"
    };
  }

  private async check(refresh: boolean): Promise<ReleaseUpdateCheck> {
    const now = this.context.now().getTime();
    if (!refresh && this.cachedCheck && now < this.checkExpiresAt) return this.cachedCheck;
    if (!refresh && this.checkPromise) return await this.checkPromise;
    const pending = (this.context.checkUpdate ?? (() => checkReleaseUpdate(this.context.updaterPath!)))();
    this.checkPromise = pending;
    try {
      const result = validateReleaseUpdateCheck(await pending);
      this.cachedCheck = result;
      this.checkExpiresAt = now + CHECK_TTL_MS;
      return result;
    } finally {
      if (this.checkPromise === pending) this.checkPromise = null;
    }
  }

  private supported(): boolean {
    const releaseInstall = this.context.releaseInstall ?? Bun.env.XUANWU_RELEASE_INSTALL === "1";
    const injected = Boolean(this.context.checkUpdate && this.context.triggerUpdate);
    return releaseInstall && (injected || existsSync(this.context.updaterPath!));
  }

  private jobsDir(): string {
    return join(this.context.stateDir, "release-update-jobs");
  }

  private async activeJobID(): Promise<string> {
    return await readFirstExistingPointer(this.jobsDir(), ["pending", "active"]);
  }

  private async latestJob(): Promise<ReleaseUpdateJob | null> {
    const id = await readPointer(this.jobsDir(), "latest");
    return id ? await readJob(join(this.jobsDir(), id), id) : null;
  }
}

async function defaultTriggerUpdate(): Promise<void> {
  if (process.platform === "darwin") {
    const uid = process.getuid?.();
    if (!Number.isInteger(uid)) throw new Error("cannot resolve launchd user domain");
    const label = `${Bun.env.XUANWU_LAUNCHD_LABEL || "com.xiaobei.xuanwu"}.updater`;
    await execFileAsync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], { timeout: 10_000 });
    return;
  }
  if (process.platform === "linux") {
    const service = `${Bun.env.XUANWU_SERVICE_NAME || "xuanwu"}-updater.service`;
    await execFileAsync("systemctl", ["--user", "start", "--no-block", service], { timeout: 10_000 });
    return;
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

async function writePointer(root: string, name: string, value: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const staged = join(root, `.${name}.${process.pid}`);
  await writeFile(staged, `${value}\n`, { mode: 0o600 });
  await rename(staged, join(root, name));
}

async function writeField(root: string, name: string, value: string): Promise<void> {
  const staged = join(root, `.${name}.${process.pid}`);
  await writeFile(staged, `${value}\n`, { mode: 0o600 });
  await rename(staged, join(root, name));
}

async function readFirstExistingPointer(root: string, names: string[]): Promise<string> {
  for (const name of names) {
    const value = await readPointer(root, name);
    if (value) return value;
  }
  return "";
}

async function readPointer(root: string, name: string): Promise<string> {
  const value = await readFile(join(root, name), "utf8").catch(() => "");
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/.test(id) ? id : "";
}

async function removePointerIfMatches(root: string, name: string, expected: string): Promise<void> {
  if (await readPointer(root, name) === expected) await rm(join(root, name), { force: true });
}

async function readJob(root: string, id: string): Promise<ReleaseUpdateJob | null> {
  if (!existsSync(root)) return null;
  const field = async (name: string) => (await readFile(join(root, name), "utf8").catch(() => "")).trim();
  return {
    backup_ref: await field("backup_ref"),
    created_at: await field("created_at"),
    error_code: await field("error_code"),
    from_version: await field("from_version"),
    id,
    state: await field("state"),
    target_version: await field("target_version"),
    updated_at: await field("updated_at")
  };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 240) : String(error || "unknown error").slice(0, 240);
}
