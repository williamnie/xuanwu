import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../db/database.ts';
import { createDefaultRouter, createRequestHandler } from './server.ts';

const range = 'from=2026-09-01T00%3A00%3A00.000Z&to=2026-09-29T00%3A00%3A00.000Z';
test('statistics read API validates ranges, dimensions and pagination, preserves auth and has no writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'delivery-api-979-'));
  const db = await openDatabase({ stateDir: root });
  try {
    db.sqlite.run("insert into projects(id,name,cwd,created_at,updated_at) values ('demo','Demo','/tmp/delivery-api','2026-09-01','2026-09-01')");
    const router = createDefaultRouter({ database: db });
    const handle = createRequestHandler(router, 'test-auth');
    const url = 'http://localhost/api/system/delivery-effectiveness?';
    expect((await handle(new Request(url + range))).status).toBe(401);
    const get = (query: string) => handle(new Request(url + query, { headers: { authorization: 'Bearer test-auth' } }));
    const before = db.sqlite.query('select total_changes() as n').get();
    const response = await get(range + '&project_id=demo&task_type=engineering_task&limit=10');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ contract: 'xw.delivery-effectiveness.v2', sampled_works: 0,
      delivery_rate: null, has_more: false, memory: { injection_estimated_token_count: null }, cost: { by_currency: [] }, supervisor: { total_cost: null } });
    for (const invalid of ['limit=101', 'limit=0', 'before_issue_id=-1', 'task_type=bug', 'wat=1', 'limit=1&limit=2',
      'project_id=', 'from=2026-02-30T00:00:00.000Z', 'from=2026-01-01T00:00:00.000Z&to=2026-09-01T00:00:00.000Z',
      'from=2026-09-29T00:00:00.000Z&to=2026-09-01T00:00:00.000Z']) expect((await get(invalid)).status).toBe(400);
    expect((await get('project_id=missing')).status).toBe(404);
    expect(db.sqlite.query('select total_changes() as n').get()).toEqual(before);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
