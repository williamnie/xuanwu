import { cleanString } from "../../util/values.ts";
import { type Turn } from "./liveSessionTurn.ts";
import { type ClaudeLiveSessionHost } from "./liveSessionModel.ts";

export class ClaudeTranscriptSnapshot {
  private snapshot?: { fileSize?: number; lastModified: number };
  private lastCwd = "";
  /** 只认当前空闲期的快照，玄武自己的写入不算外部改动。 */
  private idleGeneration = 0;

  constructor(private readonly sessionId: string, private readonly host: ClaudeLiveSessionHost, private readonly idle: () => boolean) {}

  invalidate(): void {
    this.idleGeneration += 1;
    this.snapshot = undefined;
  }

async capture(cwd: string): Promise<void> {
    this.lastCwd = cwd || this.lastCwd;
    const generation = ++this.idleGeneration;
    let snapshot: typeof this.snapshot;
    try {
      const info = await this.host.sessionInfo(this.sessionId, this.lastCwd);
      snapshot = info ? { fileSize: info.fileSize, lastModified: info.lastModified } : undefined;
    } catch {
      snapshot = undefined;
    }
    if (generation === this.idleGeneration && this.idle()) this.snapshot = snapshot;
  }

/** 空闲期间外部续写会使常驻进程上下文过期。 */
  async changedOutside(turn: Turn): Promise<boolean> {
    if (!this.snapshot) return false;
    try {
      const info = await this.host.sessionInfo(this.sessionId, cleanString(turn.request.options.cwd));
      if (!info) return false;
      return info.lastModified !== this.snapshot.lastModified || info.fileSize !== this.snapshot.fileSize;
    } catch {
      return false;
    }
  }
}
