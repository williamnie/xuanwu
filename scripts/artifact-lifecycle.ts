#!/usr/bin/env bun
import { resolve } from "node:path";
import {
  restoreArtifactLifecycle,
  runArtifactLifecycle
} from "../backend-ts/src/artifacts/lifecycle.ts";

type Flags = Record<string, string | boolean>;

async function main(): Promise<void> {
  const command = Bun.argv[2]?.trim();
  const flags = parseFlags(Bun.argv.slice(3));
  if (command === "report" || command === "apply") {
    allowOnly(flags, [
      "actor", "apply", "archive-root", "audit-ref", "confirm-consumer-zero",
      "confirm-restore-tested", "minimum-free-bytes", "reason", "report", "root"
    ]);
    if (command === "report" && flags.apply === true) throw new Error("report does not accept --apply");
    if (command === "apply" && flags.apply !== true) throw new Error("apply requires --apply");
    const applied = command === "apply";
    const report = await runArtifactLifecycle({
      ...(applied ? { actor: authorization(flags) } : {}),
      apply: applied,
      archiveRoot: resolve(required(flags, "archive-root")),
      confirmConsumerZero: flags["confirm-consumer-zero"] === true,
      confirmRestoreTested: flags["confirm-restore-tested"] === true,
      minimumFreeBytes: optionalNonNegativeInteger(flags, "minimum-free-bytes"),
      reportPath: resolve(required(flags, "report")),
      root: resolve(required(flags, "root"))
    });
    print(report);
    if (applied && report.application_support.target_status !== "passed") process.exitCode = 1;
    return;
  }
  if (command === "restore") {
    allowOnly(flags, ["actor", "apply", "audit-ref", "manifest", "reason", "report", "root"]);
    const report = await restoreArtifactLifecycle({
      ...authorization(flags),
      apply: flags.apply === true,
      manifestPath: resolve(required(flags, "manifest")),
      reportPath: resolve(required(flags, "report")),
      root: resolve(required(flags, "root"))
    });
    print(report);
    return;
  }
  throw new Error("usage: artifact-lifecycle.ts <report|apply|restore> [flags]");
}

function parseFlags(args: string[]): Flags {
  const booleans = new Set(["apply", "confirm-consumer-zero", "confirm-restore-tested"]);
  const flags: Flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!name || name in flags) throw new Error(`duplicate or invalid flag: ${arg}`);
    if (booleans.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    flags[name] = value;
  }
  return flags;
}

function authorization(flags: Flags) {
  return {
    actor: required(flags, "actor"),
    auditRef: required(flags, "audit-ref"),
    reason: required(flags, "reason")
  };
}

function allowOnly(flags: Flags, allowed: string[]): void {
  const unknown = Object.keys(flags).filter((flag) => !allowed.includes(flag));
  if (unknown.length > 0) throw new Error(`unknown flags: ${unknown.map((flag) => `--${flag}`).join(", ")}`);
}

function required(flags: Flags, name: string): string {
  const value = typeof flags[name] === "string" ? String(flags[name]).trim() : "";
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function optionalNonNegativeInteger(flags: Flags, name: string): number | undefined {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
