#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AUTOMATION_TABLES, AUTOMATION_TARGET_TABLES } from "../backend-ts/src/xuanwu/automationSemantics.ts";
const args = parse(process.argv.slice(2));
for (const key of ["backupDb", "restoredDb", "report"]) if (!args[key]) fail(`--${key.replace(/[A-Z]/g, c=>`-${c.toLowerCase()}`)} is required`);
const backup = new Database(resolve(args.backupDb), { readonly: true, strict: true });
const restored = new Database(resolve(args.restoredDb), { readonly: true, strict: true });
try {
  const left = snapshot(backup); const right = snapshot(restored);
  const passed = left.quick_check === "ok" && right.quick_check === "ok" && left.foreign_key_violations === 0 && right.foreign_key_violations === 0 && left.checksum === right.checksum;
  const report = { contract: "xw.automation-rollback-restore.v1", generated_at: new Date().toISOString(), backup_database: resolve(args.backupDb), restored_database: resolve(args.restoredDb), backup: left, restored: right, passed };
  mkdirSync(dirname(resolve(args.report)), { recursive: true }); writeFileSync(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify(report, null, 2));
  if (!passed) process.exitCode = 1;
} finally { backup.close(); restored.close(); }
function snapshot(db) { return { quick_check: scalar(db,"pragma quick_check"), foreign_key_violations: rows(db,"pragma foreign_key_check").length, checksum: sha(JSON.stringify([...AUTOMATION_TABLES,...AUTOMATION_TARGET_TABLES].map(t=>[t,rows(db,`select * from ${t} order by rowid`)]))) }; }
function rows(db,sql){return db.query(sql).all();} function scalar(db,sql){return String(Object.values(db.query(sql).get()||{})[0]||"");} function sha(v){return createHash("sha256").update(v).digest("hex");}
function parse(argv){const out={backupDb:"",restoredDb:"",report:""};for(let i=0;i<argv.length;i+=1){const a=argv[i];if(a==="--backup-db")out.backupDb=argv[++i]||"";else if(a==="--restored-db")out.restoredDb=argv[++i]||"";else if(a==="--report")out.report=argv[++i]||"";else fail(`unknown argument: ${a}`);}return out;} function fail(m){console.error(m);process.exit(2);}
