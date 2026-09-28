import type { RunnerDatabase } from "../db/database.ts";
import type { PiMemoryItem } from "../db/repositories/pi.ts";
import { parseMemoryExperience } from "./memoryExperience.ts";
import { containsSensitiveMemoryContent, retrievableMemoryContent, retrievableMemoryKind } from "./memoryPolicy.ts";

// 利用已有 scope 索引取有界窗口，不扫描 history、不建第二套索引或存储。
export const MEMORY_SCAN_LIMIT = 512;
export const MEMORY_CANDIDATE_LIMIT = 24;
export const MEMORY_SCOPE_LIMIT = 10;
export const MEMORY_TECHNICAL_LIMIT = 3;
const MAX_CONTENT_CHARS = 16384;
const MAX_QUERY_CHARS = 4096;
const MAX_TERMS = 32;

export type MemoryTaskContext = {
  query?: string;
  taskDescription?: string;
  errorText?: string;
  filePaths?: string[];
  version?: string;
  kind?: string;
};
export type MemoryScope = { scope: string; scopeId?: string };
export type RankedMemory = { item: PiMemoryItem; score: number; reason: string };

// 小型词汇归一化用于候选召回；复杂适用性由同一 Pi 会话再筛选。
const SYNONYMS = [
  ["timeout", "timed out", "deadline exceeded", "etimedout", "超时", "逾时"],
  ["disconnect", "disconnected", "connection lost", "断线", "断连", "连接中断"],
  ["race", "race condition", "竞争", "竞态"],
  ["async", "asynchronous", "异步"],
  ["callback", "回调"],
  ["duplicate response", "write after end", "err_stream_write_after_end", "headers already sent", "重复写入", "重复响应"],
  ["permission denied", "eacces", "权限不足", "无权限"],
  ["out of memory", "oom", "内存不足", "内存耗尽"]
];
const STOP_WORDS = new Set(["the", "a", "an", "is", "in", "on", "to", "for", "of", "and", "or", "when", "only", "with", "still",
  "this", "that", "can", "be", "should", "fix", "error", "issue", "需要", "修复", "问题", "出现", "导致", "仍然", "可能", "执行", "请求"]);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });

export function technicalMemory(item: Pick<PiMemoryItem, "kind" | "authority"> & { content?: string }): boolean {
  return item.authority === "evidence_backed" || ["debugging_pattern", "resolution"].includes(item.kind) ||
    Boolean(item.content && parseMemoryExperience(item.content));
}

export function memoryTaskText(input: MemoryTaskContext): string {
  return [input.query, input.errorText, ...(input.filePaths ?? []).slice(0, 8), input.taskDescription]
    .filter((value): value is string => typeof value === "string").map((value) => value.slice(0, MAX_QUERY_CHARS))
    .join("\n").slice(0, MAX_QUERY_CHARS);
}

function terms(text: string): string[] {
  const lower = text.toLowerCase();
  const aliases = SYNONYMS.filter((group) => group.some((word) => containsTerm(lower, word))).flat();
  const words = lower.match(/[a-z0-9_][a-z0-9_./:-]+|[\p{Script=Han}]{2,}/gu) ?? [];
  const segmented = words.flatMap((word) => /\p{Script=Han}/u.test(word)
    ? Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]);
  return [...new Set([...aliases, ...segmented].filter((word) => !STOP_WORDS.has(word)))].slice(0, MAX_TERMS);
}

function matches(text: string, needles: string[]): string[] {
  const lower = text.toLowerCase();
  return needles.filter((word) => containsTerm(lower, word));
}

function containsTerm(text: string, term: string): boolean {
  if (/\p{Script=Han}/u.test(term)) return text.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`, "i").test(text);
}

function versionMatches(recorded: string, input: MemoryTaskContext): boolean {
  const current = (input.version || memoryTaskText(input)).toLowerCase();
  const versions = recorded.toLowerCase().match(/\bv?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?\b|\b[a-f0-9]{7,40}\b/g);
  // 非结构化版本说明无法推断兼容范围；要求调用方提供相同版本说明。
  if (!versions?.length) return Boolean(input.version?.trim()) && input.version!.trim().toLowerCase() === recorded.trim().toLowerCase();
  const currentVersions = current.match(/\bv?\d+\.\d+(?:\.\d+)?(?:-[a-z0-9.-]+)?\b|\b[a-f0-9]{7,40}\b/g) ?? [];
  const recordedSet = new Set(versions.map((version) => version.replace(/^v/, "")));
  const currentSet = new Set(currentVersions.map((version) => version.replace(/^v/, "")));
  return recordedSet.size === currentSet.size && [...recordedSet].every((version) => currentSet.has(version));
}

function applicabilityMatches(appliesWhen: string, task: string): boolean {
  const [positive, ...negative] = appliesWhen.split(/(?:不适用(?:于)?|除外|excluding|except|not applicable(?: to)?)/i);
  if (negative.some((clause) => matches(task, terms(clause)).length > 0)) return false;
  const anchors = terms(positive);
  if (anchors.length === 0 || matches(task, anchors).length === 0) return false;
  // 显式否定、反向条件不能仅因词相同而命中。
  let remaining = positive.toLowerCase();
  for (const group of SYNONYMS) {
    if (!group.some((word) => containsTerm(positive.toLowerCase(), word))) continue;
    if (group.some((word) => new RegExp(`(?:no |not |without |非|无|没有|不)[^,;。；\\n]{0,8}${word}`, "i").test(task))) return false;
    if (!group.some((word) => containsTerm(task.toLowerCase(), word))) return false;
    for (const word of [...group].sort((a, b) => b.length - a.length)) remaining = remaining.replaceAll(word, " ");
  }
  const conditions = [...segmenter.segment(remaining)].filter((word) => word.isWordLike)
    .map((word) => word.segment).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
  return conditions.every((word) => containsTerm(task.toLowerCase(), word) &&
    !new RegExp(`(?:no |not |without |非|无|没有|不)[^,;。；\\n]{0,8}${word}`, "i").test(task));
}

export function rankMemoryCandidates(
  db: RunnerDatabase, scopes: MemoryScope[], input: MemoryTaskContext, projectID?: string
) {
  const task = memoryTaskText(input);
  const needles = terms(task);
  const ranked: RankedMemory[] = [];
  let scanned = 0;
  let scanLimited = false;
  const excluded = { ineligible: 0, version_mismatch: 0, applicability_mismatch: 0, unrelated: 0 };
  // 旧全局偏好曾用空 scope_id，仍按 runner 全局偏好读取。
  const windows = scopes.flatMap((scope) => scope.scope === "global" && (!scope.scopeId || scope.scopeId === "runner")
    ? [{ scope: "global", scopeId: "runner" }, { scope: "global", scopeId: "" }] : [scope]);
  for (const scope of windows.slice(0, MEMORY_SCOPE_LIMIT)) {
    // LIMIT 位于排序/文本匹配之前，查询工作量不随历史条数增长。超出窗口通过元数据明确告知。
    const pool = db.sqlite.query<PiMemoryItem & { suppressed: number }, [string, string, number]>(`with window as materialized (
      select rowid as memory_rowid from pi_memory_items indexed by idx_pi_memory_scope
      where scope=? and scope_id=? order by updated_at desc, rowid desc limit ?)
      select m.id, m.scope, m.scope_id, m.kind,
        case when length(m.content)<=${MAX_CONTENT_CHARS} then m.content else '' end as content,
        m.source_type, m.source_id, m.confidence, m.pinned, m.disabled, m.memory_type, m.layer,
        m.authority, m.authorized_by, m.authorized_at, m.memory_key, m.occurrence_count, m.last_seen_at,
        m.citation_type, m.citation_id, m.citation_label, m.citation_url, m.revision, m.created_at, m.updated_at,
        exists(select 1 from pi_memory_suppressions s where s.scope=m.scope and s.scope_id=m.scope_id and s.memory_key=m.memory_key) as suppressed
      from window w join pi_memory_items m on m.rowid=w.memory_rowid order by m.updated_at desc, m.rowid desc`)
      .all(scope.scope, scope.scopeId ?? "runner", MEMORY_SCAN_LIMIT + 1);
    scanLimited ||= pool.length > MEMORY_SCAN_LIMIT;
    scanned += Math.min(pool.length, MEMORY_SCAN_LIMIT);
    for (const item of pool.slice(0, MEMORY_SCAN_LIMIT)) {
      if (item.disabled || item.suppressed || !item.content ||
        !retrievableMemoryKind(item.kind) || !retrievableMemoryContent(item.kind, item.content) ||
        containsSensitiveMemoryContent(item.content) || (input.kind && item.kind !== input.kind)) { excluded.ineligible++; continue; }
      const experience = parseMemoryExperience(item.content);
      const technical = technicalMemory(item);
      if (technical && (!projectID || item.scope !== "project" || item.scope_id !== projectID ||
        item.confidence === "low" || !experience || !task)) { excluded.ineligible++; continue; }
      if (technical && !versionMatches(experience!.version, input)) { excluded.version_mismatch++; continue; }
      if (technical && !applicabilityMatches(experience!.applies_when, task)) { excluded.applicability_mismatch++; continue; }
      // failed_attempts、验证记录和来源不是正向召回信号。
      const searchable = experience ? `${experience.applies_when}\n${experience.symptom}\n${experience.root_cause}\n${experience.resolution}` : `${item.kind}\n${item.content}`;
      const hits = matches(searchable, needles);
      if (!technical && input.query?.trim() && searchable.toLowerCase().includes(input.query.trim().toLowerCase())) {
        hits.push(input.query.trim().slice(0, 128));
      }
      // 上下文投影保留作用域策略语义；显式 query 则仍是纯文本查询。
      if (task && hits.length === 0 && (technical || input.query?.trim())) { excluded.unrelated++; continue; }
      const score = hits.length + (experience ? matches(experience.symptom, needles).length * 2 : 0);
      ranked.push({ item, score, reason: technical
        ? `task terms ${hits.slice(0, 4).join(", ")}; project, applies_when and version matched; Pi must verify applicability`
        : hits.length ? `task terms ${hits.slice(0, 4).join(", ")} matched` : "" });
    }
  }
  ranked.sort((a, b) => Number(technicalMemory(a.item)) - Number(technicalMemory(b.item)) ||
    Number(b.item.authority === "user_explicit") - Number(a.item.authority === "user_explicit") || b.score - a.score ||
    b.item.pinned - a.item.pinned || b.item.updated_at.localeCompare(a.item.updated_at) || a.item.id.localeCompare(b.item.id));
  return { candidates: ranked.slice(0, MEMORY_CANDIDATE_LIMIT), scanned, scanLimited, excluded,
    omittedByCandidateLimit: Math.max(0, ranked.length - MEMORY_CANDIDATE_LIMIT) };
}
