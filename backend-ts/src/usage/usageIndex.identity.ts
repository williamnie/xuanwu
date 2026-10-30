import { Database } from "bun:sqlite";
import { existsSync, statSync, type Stats } from "node:fs";
import { scalarNumber, metadata, scalarText } from "./usageIndex.metadata.ts";
import { USAGE_INDEX_VERSION } from "./usageIndex.model.ts";

// 校验结果只复用于相同的数据库及 WAL；外部写入、替换或删除会使指纹失效。
export function usageIndexIdentity(indexPath: string): string | undefined {
  try {
    const file = statSync(indexPath);
    if (!file.isFile()) return undefined;
    const identity = (value: Stats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    let wal = "";
    try {
      wal = identity(statSync(`${indexPath}-wal`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    return `${identity(file)}|${wal}`;
  } catch {
    return undefined;
  }
}

export function usageIndexIsValid(indexPath: string, root: string, verifiedIdentity?: string): boolean {
  if (!existsSync(indexPath)) return false;
  let db: Database | undefined;
  try {
    db = new Database(indexPath, { readonly: true, strict: true });
    const version = scalarNumber(db, "pragma user_version");
    const source = metadata(db, "source_root");
    if (version !== USAGE_INDEX_VERSION || source !== root) return false;
    // Reader 已完整校验的同一索引无需在每个短命 worker 中再次遍历历史数据。
    if (verifiedIdentity && usageIndexIdentity(indexPath) === verifiedIdentity) return true;
    return scalarText(db, "pragma quick_check") === "ok";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
