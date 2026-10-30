

export const BUCKET_QUERY = `
  select cwd, session_id, min(timestamp_ms) as timestamp_ms,
    sum(events) as events,
    sum(cached_input_tokens) as cached_input_tokens,
    sum(input_tokens) as input_tokens,
    sum(output_tokens) as output_tokens,
    sum(reasoning_output_tokens) as reasoning_output_tokens,
    sum(total_tokens) as total_tokens
  from buckets group by day, cwd, session_id
  order by day asc, cwd asc, session_id asc
`;

export const INSERT_EVENT = `
  insert into events(
    path, byte_offset, timestamp_ms, timestamp, cwd, session_id, info_json, limits_json,
    cached_input_tokens, input_tokens, output_tokens, reasoning_output_tokens, total_tokens
  ) values(?,?,?,?,?,?,?,?,?,?,?,?,?)
`;

export const UPSERT_BUCKET = `
  insert into buckets(
    path, day, cwd, session_id, timestamp_ms, events,
    cached_input_tokens, input_tokens, output_tokens, reasoning_output_tokens, total_tokens
  ) values(?,?,?,?,?,?,?,?,?,?,?)
  on conflict(path, day, cwd, session_id) do update set
    timestamp_ms=min(timestamp_ms, excluded.timestamp_ms),
    events=events+excluded.events,
    cached_input_tokens=cached_input_tokens+excluded.cached_input_tokens,
    input_tokens=input_tokens+excluded.input_tokens,
    output_tokens=output_tokens+excluded.output_tokens,
    reasoning_output_tokens=reasoning_output_tokens+excluded.reasoning_output_tokens,
    total_tokens=total_tokens+excluded.total_tokens
`;

export const UPSERT_FILE = `
  insert into files(path,inode,size,mtime_ms,offset,tail_checksum,last_cwd,last_session_id,corrupt_lines)
  values(?,?,?,?,?,?,?,?,?)
  on conflict(path) do update set
    inode=excluded.inode,
    size=excluded.size,
    mtime_ms=excluded.mtime_ms,
    offset=excluded.offset,
    tail_checksum=excluded.tail_checksum,
    last_cwd=excluded.last_cwd,
    last_session_id=excluded.last_session_id,
    corrupt_lines=excluded.corrupt_lines
`;
