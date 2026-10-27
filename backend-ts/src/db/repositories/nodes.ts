import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { RunnerDatabase } from "../database.ts";
import { cleanString } from "../../util/values.ts";

export const NODE_TOKEN_PREFIX = "xwn_";
const NODE_NAME_MAX_LENGTH = 64;

export type NodeInfo = {
  allowed_roots: string[];
  /** 节点同时执行的任务上限（节点 --max-parallel），默认 1。 */
  max_parallel?: number;
  hostname: string;
  os: string;
  providers: NodeProviderInfo[];
  version: string;
};

export type NodeProviderInfo = {
  capabilities: string[];
  id: string;
  interrupt_scope?: "active" | "session" | "turn";
  /** 中心可经 provider.read 调用的只读方法。 */
  read_methods?: string[];
  /** 中心可经 provider.session 调用的会话方法（新建、续写）。 */
  session_methods?: string[];
  ready: boolean;
  reason?: string;
  version?: string;
};

const NODE_PROVIDER_CAPABILITIES = new Set(["issue_execution", "interrupt", "approvals", "model_list", "resume_session", "sessions"]);
export const NODE_PROVIDER_READ_METHODS = ["listModels", "listSessionTurns", "listSessions", "readSession"] as const;
export const NODE_PROVIDER_SESSION_METHODS = ["createSession", "sendSessionMessage"] as const;
const INTERRUPT_SCOPES = new Set(["active", "session", "turn"]);

export type RemoteNode = {
  created_at: string;
  id: string;
  info: NodeInfo;
  last_remote_addr: string;
  last_seen_at: string;
  name: string;
  revoked_at: string;
  updated_at: string;
};

const EMPTY_INFO: NodeInfo = { allowed_roots: [], hostname: "", os: "", providers: [], version: "" };

/** 创建节点并返回明文密钥；明文只在这里出现一次，库里只存哈希。 */
export function createRemoteNode(
  db: RunnerDatabase,
  input: { name: unknown },
  timestamp = new Date()
): { node: RemoteNode; token: string } {
  const name = cleanString(input.name);
  if (name === "") throw new Error("name is required");
  if (name.length > NODE_NAME_MAX_LENGTH) throw new Error(`name must be at most ${NODE_NAME_MAX_LENGTH} characters`);
  const id = `node_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const token = `${NODE_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  const now = timestamp.toISOString();
  db.sqlite.run(
    "insert into nodes (id, name, token_hash, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [id, name, hashNodeToken(token), now, now]
  );
  return { node: mustGetRemoteNode(db, id), token };
}

export function listRemoteNodes(db: RunnerDatabase): RemoteNode[] {
  return db.sqlite.query<Record<string, unknown>, []>(`
    select ${NODE_COLUMNS} from nodes where revoked_at='' order by created_at, id
  `).all().map(mapRow);
}

export function getRemoteNode(db: RunnerDatabase, id: string): RemoteNode | null {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`select ${NODE_COLUMNS} from nodes where id=?`).get(id);
  return row ? mapRow(row) : null;
}

/** 按明文密钥查找未吊销的节点；格式不对直接拒绝，不查库。 */
export function findRemoteNodeByToken(db: RunnerDatabase, token: string): RemoteNode | null {
  const value = cleanString(token);
  if (!value.startsWith(NODE_TOKEN_PREFIX)) return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(`
    select ${NODE_COLUMNS} from nodes where token_hash=? and revoked_at=''
  `).get(hashNodeToken(value));
  return row ? mapRow(row) : null;
}

export function recordRemoteNodeHello(
  db: RunnerDatabase,
  id: string,
  input: { info: NodeInfo; remoteAddr: string },
  timestamp = new Date()
): RemoteNode {
  const now = timestamp.toISOString();
  db.sqlite.run(
    "update nodes set info_json=?, last_seen_at=?, last_remote_addr=?, updated_at=? where id=?",
    [JSON.stringify(input.info), now, input.remoteAddr, now, id]
  );
  return mustGetRemoteNode(db, id);
}

export function touchRemoteNode(db: RunnerDatabase, id: string, timestamp = new Date()): void {
  db.sqlite.run("update nodes set last_seen_at=? where id=?", [timestamp.toISOString(), id]);
}

export function revokeRemoteNode(db: RunnerDatabase, id: string, timestamp = new Date()): boolean {
  const now = timestamp.toISOString();
  const result = db.sqlite.run("update nodes set revoked_at=?, updated_at=? where id=? and revoked_at=''", [now, now, id]);
  return result.changes > 0;
}

/** 校验节点上报的 info，丢弃未知字段并限制大小，避免任意 JSON 进库。 */
export function normalizeNodeInfo(value: unknown): NodeInfo {
  const source = isRecord(value) ? value : {};
  const roots = Array.isArray(source.allowed_roots) ? source.allowed_roots : [];
  const providers = Array.isArray(source.providers) ? source.providers : [];
  return {
    allowed_roots: roots.map(cleanString).filter((root) => root !== "").slice(0, 32).map((root) => root.slice(0, 1024)),
    hostname: cleanString(source.hostname).slice(0, 255),
    ...(Number.isInteger(source.max_parallel) && Number(source.max_parallel) > 0
      ? { max_parallel: Math.min(Number(source.max_parallel), 64) }
      : {}),
    os: cleanString(source.os).slice(0, 64),
    providers: providers.filter(isRecord).slice(0, 16).map((provider): NodeProviderInfo => ({
      capabilities: (Array.isArray(provider.capabilities) ? provider.capabilities : [])
        .filter((capability): capability is string => NODE_PROVIDER_CAPABILITIES.has(String(capability))),
      id: cleanString(provider.id).slice(0, 64),
      ...(INTERRUPT_SCOPES.has(String(provider.interrupt_scope))
        ? { interrupt_scope: provider.interrupt_scope as NodeProviderInfo["interrupt_scope"] }
        : {}),
      ...(Array.isArray(provider.session_methods)
        ? { session_methods: provider.session_methods.filter((method): method is string => (NODE_PROVIDER_SESSION_METHODS as readonly string[]).includes(String(method))) }
        : {}),
      ...(Array.isArray(provider.read_methods)
        ? { read_methods: provider.read_methods.filter((method): method is string => (NODE_PROVIDER_READ_METHODS as readonly string[]).includes(String(method))) }
        : {}),
      ready: provider.ready === true,
      ...(cleanString(provider.reason) === "" ? {} : { reason: cleanString(provider.reason).slice(0, 512) }),
      ...(cleanString(provider.version) === "" ? {} : { version: cleanString(provider.version).slice(0, 64) })
    })).filter((provider) => provider.id !== ""),
    version: cleanString(source.version).slice(0, 64)
  };
}

function hashNodeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mustGetRemoteNode(db: RunnerDatabase, id: string): RemoteNode {
  const node = getRemoteNode(db, id);
  if (!node) throw new Error("node missing after write");
  return node;
}

const NODE_COLUMNS = "id, name, info_json, last_seen_at, last_remote_addr, created_at, updated_at, revoked_at";

function mapRow(row: Record<string, unknown>): RemoteNode {
  return {
    created_at: String(row.created_at ?? ""),
    id: String(row.id ?? ""),
    info: parseInfo(row.info_json),
    last_remote_addr: String(row.last_remote_addr ?? ""),
    last_seen_at: String(row.last_seen_at ?? ""),
    name: String(row.name ?? ""),
    revoked_at: String(row.revoked_at ?? ""),
    updated_at: String(row.updated_at ?? "")
  };
}

function parseInfo(value: unknown): NodeInfo {
  try {
    return normalizeNodeInfo(JSON.parse(String(value ?? "{}")));
  } catch {
    return { ...EMPTY_INFO };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
