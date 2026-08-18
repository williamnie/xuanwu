import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 20;

export async function updatePiCredential(
  authPath: string,
  provider: string,
  credential: Record<string, unknown> | undefined
): Promise<void> {
  await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${authPath}.lock`);
  const temporary = `${authPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const current = await readCredentialFile(authPath);
    if (credential === undefined) delete current[provider];
    else current[provider] = credential;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(current, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, authPath);
    await chmod(authPath, 0o600);
  } finally {
    await rm(temporary, { force: true });
    await release();
  }
}

async function readCredentialFile(path: string): Promise<Record<string, Record<string, unknown>>> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("auth.json must contain an object");
    return value as Record<string, Record<string, unknown>>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

async function acquireLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_STALE_MS;
  while (true) {
    try {
      await mkdir(path);
      return async () => { await rm(path, { recursive: true, force: true }); };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const details = await stat(path).catch(() => undefined);
      if (details && Date.now() - details.mtimeMs > LOCK_STALE_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for Pi credential lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
    }
  }
}
