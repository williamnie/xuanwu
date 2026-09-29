import type { RunnerDatabase } from '../db/database.ts';
import { buildDeliveryEffectivenessAsync, type DeliveryQuery } from '../observability/deliveryEffectiveness.ts';
import { WORK_TYPES } from '../domain/work/contracts.ts';
import { redactRegisteredSecrets } from '../security/redactionRegistry.ts';
import { HttpError } from './errors.ts';

const activeReads = new Set<string>();
export async function readDeliveryEffectiveness(db: RunnerDatabase, request: Request) {
  const params = new URL(request.url).searchParams;
  const allowed = ['project_id', 'task_type', 'from', 'to', 'limit', 'before_issue_id'];
  for (const key of params.keys()) if (!allowed.includes(key) || params.getAll(key).length !== 1) {
    throw new HttpError(400, 'unknown or repeated delivery parameter');
  }
  const query: DeliveryQuery = {};
  for (const key of ['project_id', 'task_type'] as const) if (params.has(key)) {
    const value = params.get(key)!;
    if (!value.trim() || value.length > 256) throw new HttpError(400, `invalid ${key}`);
    query[key] = value;
  }
  if (query.task_type && !(WORK_TYPES as readonly string[]).includes(query.task_type)) throw new HttpError(400, 'invalid task_type');
  if (query.project_id && !db.sqlite.query('select 1 from projects where id=?').get(query.project_id)) throw new HttpError(404, 'project not found');
  const now = new Date();
  for (const key of ['from', 'to'] as const) if (params.has(key)) {
    const raw = params.get(key)!;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)
      || !Number.isFinite(Date.parse(raw)) || new Date(raw).toISOString() !== raw) throw new HttpError(400, 'timestamps must be canonical UTC ISO');
    query[key] = raw;
  }
  query.to ??= now.toISOString();
  query.from ??= new Date(Date.parse(query.to) - 30 * 86400_000).toISOString();
  if (query.from > query.to || Date.parse(query.to) - Date.parse(query.from) > 90 * 86400_000) throw new HttpError(400, 'range must be ordered and at most 90 days');
  for (const key of ['limit', 'before_issue_id'] as const) if (params.has(key)) {
    const raw = params.get(key)!, value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > (key === 'limit' ? 100 : Number.MAX_SAFE_INTEGER)) throw new HttpError(400, `invalid ${key}`);
    query[key] = value;
  }
  if (activeReads.has(db.path)) throw new HttpError(429, 'delivery statistics busy; retry later');
  activeReads.add(db.path);
  try { return redactRegisteredSecrets(await buildDeliveryEffectivenessAsync(db, now, query)); }
  finally { activeReads.delete(db.path); }
}
