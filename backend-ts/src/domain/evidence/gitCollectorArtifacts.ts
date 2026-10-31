import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { type EvidenceArtifactRef } from "./contracts.ts";
import {
  type GitEvidenceArtifactStore,
  type GitSnapshotArtifactWrite,
  GIT_ARTIFACT_ROOT
} from "./gitCollectorModel.ts";

export class FileSystemGitEvidenceArtifactStore implements GitEvidenceArtifactStore {
  constructor(private readonly stateDir: string) {
    if (stateDir.trim() === "") throw new Error("Git Evidence artifact state directory is required");
  }

  writeGitSnapshot(input: GitSnapshotArtifactWrite): EvidenceArtifactRef {
    const bytes = Buffer.from(input.content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.bytes || sha256 !== input.sha256) {
      throw new Error("Git snapshot artifact content does not match its declared digest");
    }
    const ref = `${GIT_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.json`;
    const path = this.artifactPath(ref);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return {
      kind: "report",
      ref,
      label: "Git Evidence snapshot manifest",
      media_type: "application/json",
      sha256
    };
  }

  private artifactPath(ref: string): string {
    if (!new RegExp(`^${GIT_ARTIFACT_ROOT}/[a-f0-9]{2}/[a-f0-9]{64}\\.json$`).test(ref)) {
      throw new Error("invalid Git Evidence artifact ref");
    }
    const root = resolve(this.stateDir, GIT_ARTIFACT_ROOT);
    const path = resolve(this.stateDir, ref);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("Git Evidence artifact ref escapes state directory");
    }
    return path;
  }
}
