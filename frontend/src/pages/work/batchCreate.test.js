import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBatch, createBatchRow, reconcileBatchRow } from './batchCreate.js';
const audit = () => ({ event_id: crypto.randomUUID() });
test('explicit separator preserves multiline paragraphs and fenced code', () => {
  const input = 'First\n\nparagraph\n```sh\n---\ncmd\n```\n---\nSecond\n\nbody';
  const rows = previewBatch(input, audit);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].goal, input.split('\n---\nSecond')[0]);
  assert.equal(rows[1].goal, 'Second\n\nbody');
  assert.notEqual(rows[0].audit.event_id, rows[1].audit.event_id);
  assert.equal(previewBatch('a\n\nb', audit).length, 1);
});
test('unknown timeout reconciles before retry with stable per-row authority', async () => {
  const row = previewBatch('one', audit)[0];
  let sent;
  const unknown = await createBatchRow(row, { status: 'triage' }, { createWork: async payload => { sent = payload; throw new Error('timeout'); } });
  assert.equal(unknown.status, 'unknown');
  assert.equal(sent.audit.event_id, row.audit.event_id);
  const created = await reconcileBatchRow(unknown, { getCreationResult: async id => { assert.equal(id, row.audit.event_id); return { status: 'created', work: { id: 'w1' } }; } });
  assert.equal(created.status, 'created');
  const failed = await reconcileBatchRow(unknown, { getCreationResult: async () => ({ status: 'not_found' }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.audit.event_id, row.audit.event_id);
  const conflict = await createBatchRow(row, {}, { createWork: async () => { throw Object.assign(new Error('conflict'), { status: 409 }); } });
  assert.equal(conflict.status, 'unknown');
});
