import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type Upload = {
  created_at: string; id: string; mime_type: string; original_name: string;
  sha256: string; size_bytes: number; storage_path: string; url: string;
};

type UploadRow = Omit<Upload, "url">;

const MAX_IMAGE_BYTES = 10 << 20;

export async function createImageUpload(db: RunnerDatabase, stateDir: string, file: File): Promise<Upload> {
  const data = Buffer.from(await file.arrayBuffer());
  if (data.byteLength > MAX_IMAGE_BYTES) throw new Error("图片不能超过 10MB");
  const mime = detectImage(data, file.name, file.type);
  const id = `upload_${crypto.randomUUID().replaceAll("-", "")}`;
  const path = uploadPath(stateDir, id, imageExt(mime));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  const timestamp = issueTimestamp();
  const sha256 = createHash("sha256").update(data).digest("hex");
  db.sqlite.run(`insert into uploads
    (id, original_name, mime_type, size_bytes, sha256, storage_path, created_at) values (?, ?, ?, ?, ?, ?, ?)`,
    [id, safeOriginalName(file.name), mime, data.byteLength, sha256, path, timestamp]);
  return mustGetUpload(db, id);
}

export function getUpload(db: RunnerDatabase, id: string): Upload | null {
  const row = db.sqlite.query<UploadRow, [string]>(`select id, original_name, mime_type,
    size_bytes, sha256, storage_path, created_at from uploads where id=?`).get(id.trim());
  return row ? mapUploadRow(row) : null;
}

export function mustGetUpload(db: RunnerDatabase, id: string): Upload {
  const upload = getUpload(db, id);
  if (!upload) throw new ProjectNotFoundError();
  return upload;
}

function detectImage(data: Buffer, filename: string, fallbackType: string): string {
  const ext = extname(filename).toLowerCase();
  const type = magicMime(data) || (ext === ".webp" ? "image/webp" : cleanMime(fallbackType));
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(type)) throw new Error("仅支持 png/jpg/webp/gif 图片");
  return type;
}

function magicMime(data: Buffer): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.subarray(0, 6).toString() === "GIF87a" || data.subarray(0, 6).toString() === "GIF89a") return "image/gif";
  if (data.subarray(0, 4).toString() === "RIFF" && data.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "";
}

function imageExt(mime: string): string { return mime === "image/png" ? ".png" : mime === "image/jpeg" ? ".jpg" : mime === "image/gif" ? ".gif" : ".webp"; }
function uploadPath(stateDir: string, id: string, ext: string): string { const now = new Date(); return join(stateDir, "uploads", "images", String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), `${id}${ext}`); }
function safeOriginalName(name: string): string { const clean = basename(name.replaceAll("\\", "/")); return clean === "" || clean === "." || clean === "/" ? "image" : clean; }
function cleanMime(value: string): string { return value.split(";")[0]?.trim().toLowerCase() ?? ""; }
function mapUploadRow(row: UploadRow): Upload { return { ...row, url: `/api/uploads/${row.id}/content` }; }
