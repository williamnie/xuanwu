import { type StoredEvidenceRecord } from "../../db/repositories/evidence.ts";

export type ApiEvidenceRecord = StoredEvidenceRecord;

export type ParsedFilter = {
  before_event_id?: number;
  cursor: string;
  issue_ids?: number[];
  kinds?: string[];
  limit: number;
  match_none?: boolean;
  project_id?: string;
  run_ids?: string[];
  statuses?: string[];
  work_id?: string;
};
