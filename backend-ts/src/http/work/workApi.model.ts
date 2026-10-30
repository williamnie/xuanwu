

export type PageInput = {
  page: number;
  page_size: number;
};

export type WorkCursorV1 = {
  filter_fingerprint: string;
  issue_id: number;
  updated_at: string;
  version: 1;
};
