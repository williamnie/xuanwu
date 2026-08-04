import type { ProviderId } from "../types.ts";
import type { SessionDetail, SessionMutationResult, SessionSummary } from "./session.ts";

/**
 * P3：独立 capability 方法签名（设计 §2.8 SessionProviderFacet / ControlProviderFacet）。
 * 每个方法对应 manifest.capabilities 中的独立 capability：
 * create/send/resume/steer/fork/interrupt 可分别声明，缺声明则 UI/API 不曝光。
 */

export type CreateSessionRequest = {
  providerId: ProviderId;
  projectId?: string;
  cwd?: string;
  initialPrompt?: string;
};

export type SendSessionMessageRequest = {
  providerId: ProviderId;
  sessionRef: string;
  text: string;
  cursorRef?: string;
};

export type ResumeSessionRequest = {
  providerId: ProviderId;
  sessionRef: string;
  cursorRef?: string;
};

export type ForkSessionRequest = {
  providerId: ProviderId;
  sessionRef: string;
  cursorRef?: string;
};

export type SessionListRequest = {
  providerId?: ProviderId;
  cursor?: string;
  limit?: number;
  projectId?: string;
};

export type SessionPage = {
  data: SessionSummary[];
  nextCursor?: string;
};

export type SteerRequest = {
  providerId: ProviderId;
  invocationRef?: string;
  sessionRef?: string;
  instruction: string;
};

export type InterruptRequest = {
  providerId: ProviderId;
  invocationRef?: string;
  sessionRef?: string;
  reason?: string;
};

export type ControlReceipt = {
  accepted: boolean;
  reason?: string;
};

/** P3：Session 标准操作 facet（create/send/resume/steer/fork/interrupt 独立可声明）。 */
export interface SessionProviderFacet {
  createSession?(input: CreateSessionRequest): Promise<SessionMutationResult>;
  listSessions?(input: SessionListRequest): Promise<SessionPage>;
  readSession?(ref: string, cursor?: string): Promise<SessionDetail>;
  sendMessage?(input: SendSessionMessageRequest): Promise<SessionMutationResult>;
  resumeSession?(input: ResumeSessionRequest): Promise<SessionMutationResult>;
  forkSession?(input: ForkSessionRequest): Promise<SessionMutationResult>;
}

/** P3：控制 facet（interrupt/steer）。 */
export interface ControlProviderFacet {
  interrupt?(input: InterruptRequest): Promise<ControlReceipt>;
  steer?(input: SteerRequest): Promise<ControlReceipt>;
}
