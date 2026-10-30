

export type PageInput = { page: number; page_size: number };

export type RunAction = "interrupt" | "resume" | "retry";

export type RunTranscriptRow = { created_at: string; id: number; payload: string };
